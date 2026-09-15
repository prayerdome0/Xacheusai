package ai.xacheus.app

import ai.xacheus.app.data.SettingsStore
import ai.xacheus.app.device.PermissionGate
import ai.xacheus.app.net.DeviceSocket
import ai.xacheus.app.net.XacheusClient
import ai.xacheus.app.ui.XacheusScreen
import ai.xacheus.app.voice.Speaker
import ai.xacheus.app.voice.SpeechEngine
import ai.xacheus.app.voice.WakeWordService
import android.Manifest
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private lateinit var settings: SettingsStore
    private lateinit var client: XacheusClient
    private lateinit var speaker: Speaker
    private lateinit var speech: SpeechEngine
    private var deviceSocket: DeviceSocket? = null

    private var serverUrl by mutableStateOf("")
    private var token by mutableStateOf("")
    private var deviceName by mutableStateOf("")
    private var wakeEnabled by mutableStateOf(false)
    private var speakReplies by mutableStateOf(true)
    private var connectionStatus by mutableStateOf("Not connected")
    private var listeningStatus by mutableStateOf("Idle")
    private var connected by mutableStateOf(false)
    private val transcript = mutableStateListOf<Turn>()

    data class Turn(val fromOwner: Boolean, val text: String)

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        val denied = results.filterValues { granted -> !granted }.keys
        if (denied.isNotEmpty()) {
            transcript.add(Turn(false, "Permission declined: ${denied.joinToString(", ")}."))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = SettingsStore(this)
        client = XacheusClient(settings)
        speaker = Speaker(this)
        speech = SpeechEngine(this)
        PermissionGate.attach(this)

        serverUrl = settings.serverUrl
        token = settings.deviceToken
        deviceName = settings.deviceName
        wakeEnabled = settings.wakeWordEnabled
        speakReplies = settings.speakReplies

        requestNotificationPermission()
        if (settings.autoConnect && settings.isPaired) connect()

        setContent {
            XacheusScreen(
                serverUrl = serverUrl,
                onServerUrlChange = { serverUrl = it },
                token = token,
                onTokenChange = { token = it },
                deviceName = deviceName,
                onDeviceNameChange = { deviceName = it },
                paired = settings.isPaired,
                status = connectionStatus,
                listeningStatus = listeningStatus,
                connected = connected,
                wakeEnabled = wakeEnabled,
                speakReplies = speakReplies,
                transcript = transcript,
                onSave = {
                    settings.serverUrl = serverUrl
                    settings.deviceToken = token
                    settings.deviceName = deviceName
                    settings.autoConnect = true
                    toast("Saved. Connecting…")
                    connect()
                },
                onConnect = { connect() },
                onDisconnect = {
                    deviceSocket?.stop()
                    deviceSocket = null
                    connected = false
                    connectionStatus = "Disconnected."
                },
                onToggleWake = { enable ->
                    if (enable) {
                        val problem = PermissionGate.ensure(this, listOf(Manifest.permission.RECORD_AUDIO), "The wake word")
                        if (problem != null) {
                            toast(problem)
                        } else {
                            settings.wakeWordEnabled = true
                            wakeEnabled = true
                            WakeWordService.start(this, true)
                            listeningStatus = "Listening for “${settings.wakeWord}” (look for the notification)."
                        }
                    } else {
                        WakeWordService.start(this, false)
                        settings.wakeWordEnabled = false
                        wakeEnabled = false
                        listeningStatus = "Stopped."
                    }
                },
                onSpeakChange = {
                    speakReplies = it
                    settings.speakReplies = it
                },
                onMicPressed = { listenOnce() },
                onSend = { text -> send(text) },
                onApprove = { approve(true) },
                onDecline = { approve(false) },
            )
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissionLauncher.launch(
                arrayOf(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO),
            )
        } else {
            permissionLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
        }
    }

    private fun connect() {
        if (!settings.isPaired) {
            connectionStatus = "Enter the server URL and device bridge token first."
            return
        }
        deviceSocket?.stop()
        deviceSocket = DeviceSocket(this, settings, lifecycleScope).also { socket ->
            socket.listener = object : DeviceSocket.Listener {
                override fun onStatus(isConnected: Boolean, detail: String) {
                    runOnUiThread {
                        connected = isConnected
                        connectionStatus = detail
                    }
                }

                override fun onCommand(command: String, summary: String) {
                    runOnUiThread {
                        transcript.add(Turn(false, "[$command] $summary"))
                    }
                }
            }
            socket.start()
        }
    }

    private fun listenOnce() {
        val problem = PermissionGate.ensure(this, listOf(Manifest.permission.RECORD_AUDIO), "Voice input")
        if (problem != null) {
            toast(problem)
            return
        }
        listeningStatus = "Listening…"
        speech.start(object : SpeechEngine.Callback {
            override fun onPartial(text: String) {
                listeningStatus = text
            }

            override fun onFinal(text: String) {
                listeningStatus = "Idle"
                send(text)
            }

            override fun onError(message: String) {
                listeningStatus = "Idle"
                transcript.add(Turn(false, message))
            }
        })
    }

    private fun send(text: String) {
        if (text.isBlank()) return
        transcript.add(Turn(true, text))
        lifecycleScope.launch {
            val reply = withContext(Dispatchers.IO) {
                runCatching { client.ask(text, "android_${settings.deviceId}") }
                    .getOrElse { error -> XacheusClient.VoiceReply("Could not reach the backend: ${error.message}", false, null) }
            }
            transcript.add(Turn(false, reply.text))
            if (settings.speakReplies) speaker.say(reply.text)
        }
    }

    private fun approve(approve: Boolean) {
        lifecycleScope.launch {
            val pending = withContext(Dispatchers.IO) { runCatching { client.pendingRuns() }.getOrDefault(emptyList()) }
            val run = pending.firstOrNull() ?: run {
                transcript.add(Turn(false, "Nothing is waiting for approval."))
                return@launch
            }
            val steps = run.optJSONArray("plan")
            val stepId = (0 until (steps?.length() ?: 0))
                .mapNotNull { steps?.optJSONObject(it) }
                .firstOrNull { it.optString("status") == "awaiting_confirmation" }
                ?.optString("id")
            if (stepId == null) {
                transcript.add(Turn(false, "No pending step on that run."))
                return@launch
            }
            val answer = withContext(Dispatchers.IO) {
                runCatching { client.confirm(run.optString("id"), stepId, approve) }
                    .getOrElse { error -> "Confirmation failed: ${error.message}" }
            }
            transcript.add(Turn(false, answer))
            if (settings.speakReplies) speaker.say(answer)
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    override fun onDestroy() {
        PermissionGate.attach(null)
        speaker.shutdown()
        speech.stop()
        super.onDestroy()
    }
}
