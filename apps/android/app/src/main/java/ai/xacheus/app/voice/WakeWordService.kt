package ai.xacheus.app.voice

import ai.xacheus.app.MainActivity
import ai.xacheus.app.R
import ai.xacheus.app.data.SettingsStore
import ai.xacheus.app.net.XacheusClient
import ai.xacheus.app.device.PermissionGate
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The always-available listener.
 *
 * This is a foreground service with a **permanent, visible notification**: Android
 * shows the microphone indicator for as long as it runs, and stopping the service
 * releases the microphone immediately. There is deliberately no hidden mode, no
 * "discreet" notification and no auto-restart trickery beyond a reboot receiver
 * that only runs when the owner switched listening on.
 */
class WakeWordService : LifecycleService() {

    private lateinit var settings: SettingsStore
    private lateinit var speaker: Speaker
    private lateinit var client: XacheusClient
    private var engine: WakeWordEngine? = null
    private var isForeground = false

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        speaker = Speaker(this)
        client = XacheusClient(settings)
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        when (intent?.action) {
            ACTION_STOP -> {
                stopListening()
                stopSelf()
                return START_NOT_STICKY
            }
        }

        startForeground(NOTIFICATION_ID, buildNotification("Say “${settings.wakeWord}” or tap to talk."))
        isForeground = true
        settings.wakeWordEnabled = true
        startListening()
        return START_STICKY
    }

    private fun startListening() {
        val problem = PermissionGate.ensure(this, listOf(PermissionGate.microphone), "The wake word")
        if (problem != null) {
            updateNotification(problem)
            stopSelf()
            return
        }

        engine?.stop()
        val wake = settings.wakeWord
        engine = SpeechLoopEngine(this) { wake }.also { active ->
            active.start(
                onWake = { utterance ->
                    if (utterance.isBlank()) {
                        updateNotification("Heard “$wake” — say your request now.")
                    } else {
                        updateNotification("“$utterance”")
                        handleUtterance(utterance)
                    }
                    // The recogniser ends its session once it reports a result, so the
                    // wake-watch loop is restarted either way. A production engine
                    // (Porcupine) hands straight off to a single-shot recogniser here.
                    restartListening()
                },
                onError = { message ->
                    updateNotification(message)
                    stopSelf()
                },
            )
        }
    }

    /** Re-arm the wake-word watch after a detection. */
    private fun restartListening() {
        if (!settings.wakeWordEnabled && !isForeground) return
        engine?.stop()
        engine = null
        startListening()
    }

    private fun handleUtterance(utterance: String) {
        lifecycleScope.launch {
            // "Xacheus, approve" / "Xacheus, decline" settles a gated step by voice.
            val normalized = utterance.trim().lowercase()
            if (APPROVAL_WORDS.any { normalized.startsWith(it) }) {
                val approve = APPROVE_WORDS.any { normalized.startsWith(it) }
                val answer = withContext(Dispatchers.IO) { confirmPending(approve) }
                updateNotification(answer)
                if (settings.speakReplies) speaker.say(answer)
                return@launch
            }

            val reply = withContext(Dispatchers.IO) {
                runCatching { client.ask(utterance, "android_${settings.deviceId}") }
                    .getOrElse { error -> XacheusClient.VoiceReply("I could not reach the backend: ${error.message}", false, null) }
            }
            updateNotification(reply.text.take(180))
            if (settings.speakReplies) speaker.say(reply.text)

            if (reply.awaitingConfirmation && reply.runId != null) {
                val pending = withContext(Dispatchers.IO) { runCatching { client.pendingRuns() }.getOrDefault(emptyList()) }
                val stepId = pending.firstOrNull { it.optString("id") == reply.runId }
                    ?.optJSONArray("plan")
                    ?.let { steps ->
                        (0 until steps.length()).mapNotNull { steps.optJSONObject(it) }
                            .firstOrNull { it.optString("status") == "awaiting_confirmation" }
                            ?.optString("id")
                    }
                if (stepId != null) {
                    val confirmation = "That needs your approval. Say “Xacheus approve” or “Xacheus decline”, or open the app."
                    updateNotification(confirmation)
                    if (settings.speakReplies) speaker.say(confirmation)
                }
            }
        }
    }

    /** Approve or decline the oldest run waiting for the owner's decision. */
    private fun confirmPending(approve: Boolean): String {
        val pending = runCatching { client.pendingRuns() }.getOrDefault(emptyList())
        val run = pending.firstOrNull() ?: return "Nothing is waiting for approval."
        val steps = run.optJSONArray("plan") ?: return "Nothing is waiting for approval."
        val stepId = (0 until steps.length())
            .mapNotNull { steps.optJSONObject(it) }
            .firstOrNull { it.optString("status") == "awaiting_confirmation" }
            ?.optString("id")
            ?: return "Nothing is waiting for approval."
        return runCatching { client.confirm(run.optString("id"), stepId, approve) }
            .getOrElse { "Confirmation failed: ${it.message}" }
    }

    private fun stopListening() {
        isForeground = false
        engine?.stop()
        engine = null
        speaker.stop()
        settings.wakeWordEnabled = false
    }

    override fun onDestroy() {
        engine?.stop()
        engine = null
        speaker.shutdown()
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? {
        super.onBind(intent)
        return null
    }

    // ----------------------------------------------------------- notification

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_LISTENING, getString(R.string.channel_listening), NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Xacheus listens for its wake word."
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_REPLIES, getString(R.string.channel_replies), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, WakeWordService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_LISTENING)
            .setContentTitle(getString(R.string.listening_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, getString(R.string.stop_listening), stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        private val APPROVAL_WORDS = listOf("approve", "approved", "yes", "confirm", "go ahead", "decline", "no", "cancel", "reject")
        private val APPROVE_WORDS = listOf("approve", "approved", "yes", "confirm", "go ahead")
        const val ACTION_STOP = "ai.xacheus.app.STOP_LISTENING"
        const val ACTION_START = "ai.xacheus.app.START_LISTENING"
        private const val CHANNEL_LISTENING = "xacheus_listening"
        private const val CHANNEL_REPLIES = "xacheus_replies"
        private const val NOTIFICATION_ID = 8801

        fun start(context: Context, enabled: Boolean) {
            val intent = Intent(context, WakeWordService::class.java).setAction(ACTION_START)
            if (enabled) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                else context.startService(intent)
            } else {
                context.startService(intent.setAction(ACTION_STOP))
            }
        }
    }
}
