package ai.xacheus.app.device

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Reads notifications — only after the owner explicitly grants notification
 * access in Android Settings. This is a standard, user-visible system grant;
 * there is no way to read notifications without it, and none is attempted here.
 */
class XacheusNotificationListener : NotificationListenerService() {

    data class Entry(
        val app: String,
        val title: String,
        val text: String,
        val postedAt: Long,
        val packageName: String,
        val key: String,
    ) {
        fun toJson() = JSONObject()
            .put("app", app)
            .put("title", title)
            .put("text", text)
            .put("postedAt", postedAt)
            .put("package", packageName)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        if (title.isBlank() && text.isBlank()) return
        live[sbn.key] = Entry(
            app = appLabel(sbn.packageName),
            title = title,
            text = text,
            postedAt = sbn.postTime,
            packageName = sbn.packageName,
            key = sbn.key,
        )
        if (live.size > 60) {
            live.entries.sortedBy { it.value.postedAt }.take(live.size - 60).forEach { live.remove(it.key) }
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        live.remove(sbn.key)
    }

    override fun onListenerConnected() {
        connected = true
    }

    override fun onListenerDisconnected() {
        connected = false
    }

    private fun appLabel(packageName: String): String = try {
        val info = packageManager.getApplicationInfo(packageName, 0)
        packageManager.getApplicationLabel(info).toString()
    } catch (_: Exception) {
        packageName
    }

    companion object {
        @Volatile private var connected = false
        private val live = ConcurrentHashMap<String, Entry>()

        fun isConnected(): Boolean = connected

        fun snapshot(): List<Entry> = live.values.sortedByDescending { it.postedAt }

        fun dismissAll(): Int {
            val service = instance ?: return 0
            var count = 0
            live.values.forEach { entry ->
                runCatching {
                    service.cancelNotification(entry.key)
                    count++
                }
            }
            live.clear()
            return count
        }

        /** Set while a listener service instance is alive. */
        @Volatile var instance: XacheusNotificationListener? = null
            private set

        fun register(service: XacheusNotificationListener) {
            instance = service
            connected = true
        }

        fun unregister() {
            instance = null
            connected = false
        }
    }

    override fun onCreate() {
        super.onCreate()
        register(this)
    }

    override fun onDestroy() {
        unregister()
        super.onDestroy()
    }
}
