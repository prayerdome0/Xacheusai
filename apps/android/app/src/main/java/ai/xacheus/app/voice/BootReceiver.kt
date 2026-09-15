package ai.xacheus.app.voice

import ai.xacheus.app.data.SettingsStore
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restores the wake-word listener after a reboot — but only when the owner had
 * switched it on. Nothing is started behind the owner's back.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val settings = SettingsStore(context)
        if (settings.wakeWordEnabled && settings.isPaired) {
            WakeWordService.start(context, true)
        }
    }
}
