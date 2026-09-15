package ai.xacheus.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

class XacheusApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createChannels(this)
    }

    private fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel("xacheus", "Xacheus", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Replies, approvals and automation notifications from Xacheus."
            },
        )
    }
}
