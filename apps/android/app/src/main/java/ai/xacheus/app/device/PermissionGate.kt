package ai.xacheus.app.device

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Runtime permission handling.
 *
 * The important behaviour: when a permission is missing we *ask*, and we tell the
 * backend honestly that the action did not happen. Xacheus must never report a
 * simulated success as a real one, and it must never pretend Android said yes.
 */
object PermissionGate {

    /** Tracks the activity that can host a permission dialog (set by MainActivity). */
    @Volatile
    private var activity: Activity? = null

    fun attach(activity: Activity?) {
        this.activity = activity
    }

    fun granted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun grantedAll(context: Context, permissions: List<String>): Boolean =
        permissions.all { granted(context, it) }

    /**
     * Ensure the permissions are granted.
     * Returns null when we are good to go, or a human-readable reason when not —
     * in which case the request has been raised and the owner can retry.
     */
    fun ensure(context: Context, permissions: List<String>, label: String): String? {
        val missing = permissions.filterNot { granted(context, it) }
        if (missing.isEmpty()) return null

        val host = activity
        if (host == null) {
            return "$label needs ${missing.joinToString(", ") { it.substringAfterLast('.') }}. Open the Xacheus app and grant it, then ask again."
        }
        ActivityCompat.requestPermissions(host, missing.toTypedArray(), REQUEST_CODE)
        return "$label needs ${missing.joinToString(", ") { it.substringAfterLast('.') }} — I asked Android for you. Approve the prompt and repeat the request."
    }

    fun notificationPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.POST_NOTIFICATIONS
        else Manifest.permission.ACCESS_NETWORK_STATE

    const val REQUEST_CODE = 4201

    val microphone = Manifest.permission.RECORD_AUDIO
    val call = Manifest.permission.CALL_PHONE
    val sms = Manifest.permission.SEND_SMS
    val camera = Manifest.permission.CAMERA
    val fineLocation = Manifest.permission.ACCESS_FINE_LOCATION
    val coarseLocation = Manifest.permission.ACCESS_COARSE_LOCATION
    val contacts = Manifest.permission.READ_CONTACTS
    val writeCalendar = Manifest.permission.WRITE_CALENDAR
    val readCalendar = Manifest.permission.READ_CALENDAR
}
