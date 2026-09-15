package ai.xacheus.app.data

import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import java.util.UUID

/**
 * Pairing and preferences. Deliberately SharedPreferences (no cloud sync, no
 * backup): the device token and your backend URL are local to this phone.
 */
class SettingsStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("xacheus", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER, "")?.trimEnd('/') ?: ""
        set(value) = prefs.edit().putString(KEY_SERVER, value.trim().trimEnd('/')).apply()

    var deviceToken: String
        get() = prefs.getString(KEY_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_TOKEN, value.trim()).apply()

    var deviceName: String
        get() = prefs.getString(KEY_NAME, android.os.Build.MODEL) ?: android.os.Build.MODEL
        set(value) = prefs.edit().putString(KEY_NAME, value).apply()

    var deviceId: String
        get() {
            val existing = prefs.getString(KEY_DEVICE_ID, null)
            if (existing != null) return existing
            val generated = "android_" + UUID.randomUUID().toString().replace("-", "").take(16)
            prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
            return generated
        }

    /** Wake word listening survives a reboot only when the owner turned it on. */
    var wakeWordEnabled: Boolean
        get() = prefs.getBoolean(KEY_WAKE, false)
        set(value) = prefs.edit().putBoolean(KEY_WAKE, value).apply()

    var wakeWord: String
        get() = prefs.getString(KEY_WAKE_WORD, "xacheus") ?: "xacheus"
        set(value) = prefs.edit().putString(KEY_WAKE_WORD, value.trim().lowercase()).apply()

    var speakReplies: Boolean
        get() = prefs.getBoolean(KEY_SPEAK, true)
        set(value) = prefs.edit().putBoolean(KEY_SPEAK, value).apply()

    var autoConnect: Boolean
        get() = prefs.getBoolean(KEY_AUTO_CONNECT, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_CONNECT, value).apply()

    val isPaired: Boolean get() = serverUrl.isNotEmpty() && deviceToken.isNotEmpty()

    fun webSocketUrl(): String {
        val base = serverUrl.replace("https://", "wss://").replace("http://", "ws://")
        return "$base/api/devices/socket?deviceId=$deviceId" +
            "&name=${java.net.URLEncoder.encode(deviceName, "UTF-8")}" +
            "&platform=android" +
            "&appVersion=0.1.0" +
            "&token=${java.net.URLEncoder.encode(deviceToken, "UTF-8")}"
    }

    companion object {
        private const val KEY_SERVER = "server_url"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_NAME = "device_name"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_WAKE = "wake_word_enabled"
        private const val KEY_WAKE_WORD = "wake_word"
        private const val KEY_SPEAK = "speak_replies"
        private const val KEY_AUTO_CONNECT = "auto_connect"
    }
}
