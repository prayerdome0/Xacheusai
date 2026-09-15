package ai.xacheus.app.net

import ai.xacheus.app.data.SettingsStore
import ai.xacheus.app.device.DeviceCommands
import ai.xacheus.app.device.Notifier
import ai.xacheus.app.voice.Speaker
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * HTTP transport for backends that cannot hold a WebSocket.
 *
 * This is not a degraded mode. A command collected here passes exactly the same
 * permission check on the server, waits for owner confirmation when it is
 * high-impact, and reports back with the same honest result modes. The only
 * difference is who opens the connection.
 *
 * Flow, every few seconds while the app is running:
 *
 *   POST /api/devices/heartbeat  { deviceId, name, capabilities }
 *     → { commands: [ { id, command, args } ] }
 *   POST /api/devices/result     { id, ok, mode, summary, data }
 *
 * Use it on serverless hosting (Vercel and friends), or on networks that break
 * long-lived connections.
 */
class PollTransport(
    private val context: Context,
    private val settings: SettingsStore,
    private val scope: CoroutineScope,
) {

    interface Listener {
        fun onStatus(connected: Boolean, detail: String)
        fun onCommand(command: String, summary: String)
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val commands = DeviceCommands(context)
    private val speaker = Speaker(context)
    private val running = AtomicBoolean(false)
    private var job: Job? = null

    @Volatile var listener: Listener? = null

    fun start() {
        if (!settings.isPaired) {
            listener?.onStatus(false, "Not paired yet — enter the server URL and device token in Settings.")
            return
        }
        if (running.getAndSet(true)) return
        job = scope.launch(Dispatchers.IO) { loop() }
    }

    fun stop() {
        running.set(false)
        job?.cancel()
        job = null
        listener?.onStatus(false, "Stopped.")
    }

    private suspend fun loop() {
        var failureStreak = 0
        listener?.onStatus(false, "Connecting (polling transport)…")

        while (running.get() && scope.isActive) {
            val commands = heartbeat()
            if (commands == null) {
                failureStreak++
                listener?.onStatus(false, "Backend unreachable (attempt $failureStreak).")
                delay(backoffMillis(failureStreak))
                continue
            }
            failureStreak = 0
            listener?.onStatus(true, "Connected as ${settings.deviceName} over HTTP polling.")

            for (command in commands) {
                val id = command.optString("id")
                val name = command.optString("command")
                val args = command.optJSONObject("args") ?: JSONObject()

                val result = withMain { commands_execute(name, args) }
                listener?.onCommand(name, result.first)

                if (settings.speakReplies && (name == "device.speak" || args.optBoolean("speak", false))) {
                    speaker.say(args.optString("text", result.first))
                }

                report(id, result.second)
            }

            val idle = commands.isEmpty()
            delay(if (idle) settings.pollSeconds * 1000L else 1_000L)
        }
    }

    /** Returns the commands waiting for us, or null when the backend is unreachable. */
    private fun heartbeat(): List<JSONObject>? {
        val body = JSONObject()
            .put("deviceId", settings.deviceId)
            .put("name", settings.deviceName)
            .put("platform", "android")
            .put("appVersion", "0.1.0")
            .put("capabilities", capabilities())

        val request = Request.Builder()
            .url("${settings.serverUrl}/api/devices/heartbeat")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .header("Authorization", "Bearer ${settings.deviceToken}")
            .build()

        return try {
            http.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) return null
                val payload = JSONObject(text)
                val array = payload.optJSONArray("commands") ?: return emptyList()
                (0 until array.length()).mapNotNull { array.optJSONObject(it) }
            }
        } catch (error: Exception) {
            null
        }
    }

    private fun report(id: String, result: Pair<String, JSONObject>) {
        if (id.isBlank()) return
        val body = JSONObject()
            .put("id", id)
            .put("ok", result.second.optBoolean("ok", true))
            .put("mode", result.second.optString("mode", "live"))
            .put("summary", result.first)
            .put("data", result.second.optJSONObject("data") ?: JSONObject())

        val request = Request.Builder()
            .url("${settings.serverUrl}/api/devices/result")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .header("Authorization", "Bearer ${settings.deviceToken}")
            .build()

        runCatching { http.newCall(request).execute().close() }
    }

    /** Android actions must touch the UI thread; wrap that cleanly. */
    private suspend fun withMain(block: () -> Pair<String, JSONObject>): Pair<String, JSONObject> =
        kotlinx.coroutines.withContext(Dispatchers.Main) { block() }

    private fun commands_execute(name: String, args: JSONObject): Pair<String, JSONObject> {
        val result = commands.execute(name, args)
        val data = JSONObject()
            .put("ok", result.ok)
            .put("mode", result.mode)
        return result.summary to data
    }

    private fun backoffMillis(streak: Int): Long = minOf(30_000L, 1_000L * (1 shl minOf(streak, 5)))

    private fun capabilities(): List<String> = listOf(
        "device.info", "device.openApp", "device.openUrl", "device.launchIntent",
        "device.createReminder", "device.createCalendarEvent",
        "device.listNotifications", "device.dismissNotifications",
        "device.mediaControl", "device.setSetting",
        "device.call", "device.sendSms", "device.shareText",
        "device.takePhoto", "device.recordVoiceNote",
        "device.readClipboard", "device.writeClipboard",
        "device.batteryStatus", "device.location", "device.speak",
        "device.vibrate", "device.torch",
    )
}
