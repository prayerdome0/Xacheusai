package ai.xacheus.app.device

import ai.xacheus.app.MainActivity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Device-side notifications: automation results, approvals waiting, and anything
 * the backend pushes with a `notify` frame.
 *
 * Notifications need the runtime POST_NOTIFICATIONS grant on Android 13+. When it
 * is missing we simply do not post — Android's own rules, not something to work
 * around.
 */
object Notifier {

    private const val CHANNEL = "xacheus_remote"
    private const val ID = 8810

    fun post(context: Context, title: String, body: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, "android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Xacheus actions", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Approvals, automation results and messages from your Xacheus backend."
                },
            )
        }

        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        manager.notify(
            ID,
            NotificationCompat.Builder(context, CHANNEL)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build(),
        )
    }
}
