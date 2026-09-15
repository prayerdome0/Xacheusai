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
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The bridge to the backend: one outbound WebSocket, reconnecting with backoff.
 *
 * Protocol (see the backend's realtime.ts):
 *   → { type: "hello",  deviceId, name, platform, appVersion, capabilities[] }
 *   ← { type: "command", id, command, args, runId }
 *   → { type: "result",  id, ok, mode, summary, data }
 *   → { type: "log",     level, message }
 *   → { type: "ping" }  /  ← { type: "pong" }
 *
 * If the socket is down, the backend reports honestly that the phone is offline
 * instead of queuing actions that would fire later without anyone watching.
 */
class DeviceSocket(
    private val context: Context,
    private val settings: SettingsStore,
    private val scope: CoroutineScope,
) {

    interface Listener {
        fun onStatus(connected: Boolean, detail: String)
        fun onCommand(command: String, summary: String)
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val commands = DeviceCommands(context)
    private val speaker = Speaker(context)
    private val running = AtomicBoolean(false)
    private var socket: WebSocket? = null
    private var attempt = 0

    @Volatile var listener: Listener? = null

    fun start() {
        if (!settings.isPaired) {
            listener?.onStatus(false, "Not paired yet — enter the server URL and device token in Settings.")
            return
        }
        if (running.getAndSet(true)) return
        connect()
    }

    fun stop() {
        running.set(false)
        socket?.close(1000, "app stopped")
        socket = null
        listener?.onStatus(false, "Disconnected.")
    }

    private fun connect() {
        val url = settings.webSocketUrl()
        listener?.onStatus(false, "Connecting to ${settings.serverUrl}…")
        val request = Request.Builder().url(url).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempt = 0
                listener?.onStatus(true, "Connected as ${settings.deviceName}.")
                send(
                    JSONObject()
                        .put("type", "hello")
                        .put("deviceId", settings.deviceId)
                        .put("name", settings.deviceName)
                        .put("platform", "android")
                        .put("appVersion", "0.1.0")
                        .put("capabilities", capabilities()),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val payload = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (payload.optString("type")) {
                    "command" -> handleCommand(payload)
                    "ping" -> send(JSONObject().put("type", "pong"))
                    "ready" -> {
                        val commands = payload.optJSONArray("commands")?.length() ?: 0
                        listener?.onStatus(true, "Paired with the backend ($commands commands available).")
                    }
                    "notify" -> {
                        val notification = payload.optJSONObject("notification")
                        val title = notification?.optString("title").orEmpty().ifBlank { "Xacheus" }
                        val body = notification?.optString("body").orEmpty()
                        if (body.isNotBlank()) {
                            Notifier.post(context, title, body)
                            listener?.onCommand("notify", body)
                        }
                    }
                    "replaced" ->
                        listener?.onStatus(false, "Another connection took over this device id. Only one phone per device id can be connected.")
                    "error" -> listener?.onStatus(false, payload.optString("message", "The backend rejected the connection."))
                    "result" -> Unit
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener?.onStatus(false, "Connection lost: ${t.message ?: "unknown error"}")
                reconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener?.onStatus(false, "Disconnected ($code).")
                reconnect()
            }
        })
    }

    private fun reconnect() {
        if (!running.get()) return
        attempt++
        val wait = minOf(30_000L, 1_000L * (1 shl minOf(attempt, 5)))
        listener?.onStatus(false, "Reconnecting in ${wait / 1000}s…")
        scope.launch {
            delay(wait)
            if (running.get()) connect()
        }
    }

    private fun handleCommand(payload: JSONObject) {
        val id = payload.optString("id")
        val command = payload.optString("command")
        val args = payload.optJSONObject("args") ?: JSONObject()

        scope.launch(Dispatchers.Main) {
            val result = commands.execute(command, args)
            listener?.onCommand(command, result.summary)

            // Speak the outcome when the owner asked for something conversational.
            if (settings.speakReplies && (command == "device.speak" || args.optBoolean("speak", false))) {
                speaker.say(args.optString("text", result.summary))
            }

            send(
                JSONObject()
                    .put("type", "result")
                    .put("id", id)
                    .put("ok", result.ok)
                    .put("mode", result.mode)
                    .put("summary", result.summary)
                    .put("data", result.data),
            )
        }
    }

    private fun send(payload: JSONObject) {
        socket?.send(payload.toString())
    }

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
