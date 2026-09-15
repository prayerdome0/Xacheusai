package ai.xacheus.app.device

import android.Manifest
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraManager
import android.location.LocationManager
import android.media.AudioManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.Settings
import android.speech.RecognizerIntent
import android.view.KeyEvent
import androidx.core.content.FileProvider
import ai.xacheus.app.net.XacheusClient
import org.json.JSONObject
import java.io.File

/**
 * The actual device actions.
 *
 * Every handler returns a [CommandResult] carrying:
 *   - `ok`      — did it really happen?
 *   - `mode`    — always "live" here: this code runs on a real phone
 *   - `summary` — what to tell the owner (and the backend) in plain language
 *
 * Nothing here silently swallows a failure, and nothing bypasses a permission
 * check. If Android says no, the answer is "not done, and here is why".
 */
class DeviceCommands(private val context: Context) {

    data class CommandResult(
        val ok: Boolean,
        val summary: String,
        val data: JSONObject = JSONObject(),
        val mode: String = "live",
    )

    fun execute(command: String, args: JSONObject): CommandResult = try {
        when (command) {
            "device.info" -> info()
            "device.openApp" -> openApp(args)
            "device.openUrl" -> openUrl(args)
            "device.launchIntent" -> launchIntent(args)
            "device.createReminder" -> createReminder(args)
            "device.createCalendarEvent" -> createCalendarEvent(args)
            "device.listNotifications" -> listNotifications()
            "device.dismissNotifications" -> dismissNotifications()
            "device.mediaControl" -> mediaControl(args)
            "device.setSetting" -> setSetting(args)
            "device.call" -> call(args)
            "device.sendSms" -> sendSms(args)
            "device.shareText" -> shareText(args)
            "device.takePhoto" -> takePhoto()
            "device.recordVoiceNote" -> recordVoiceNote(args)
            "device.readClipboard" -> readClipboard()
            "device.writeClipboard" -> writeClipboard(args)
            "device.batteryStatus" -> batteryStatus()
            "device.location" -> location()
            "device.speak" -> CommandResult(true, "Speech is handled by the app's text-to-speech engine.")
            "device.vibrate" -> vibrate(args)
            "device.torch" -> torch(args)
            else -> CommandResult(false, "This phone build does not implement \"$command\".")
        }
    } catch (error: SecurityException) {
        CommandResult(false, "Android blocked that: ${error.message ?: "permission denied"}.")
    } catch (error: Exception) {
        CommandResult(false, "Failed: ${error.message ?: error.javaClass.simpleName}")
    }

    // ------------------------------------------------------------------ basics

    private fun info(): CommandResult {
        val data = JSONObject()
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", Build.VERSION.RELEASE)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("device", Build.DEVICE)
        return CommandResult(true, "This is a ${Build.MANUFACTURER} ${Build.MODEL} running Android ${Build.VERSION.RELEASE}.", data)
    }

    private fun openApp(args: JSONObject): CommandResult {
        val raw = args.optString("package").ifEmpty { args.optString("app") }
        if (raw.isBlank()) return CommandResult(false, "Which app should I open?")

        val byAlias = ALIASES[raw.lowercase()]
        val candidates = buildList {
            if (byAlias != null) add(byAlias)
            if (raw.contains('.')) add(raw)
        }

        for (packageName in candidates) {
            val intent = context.packageManager.getLaunchIntentForPackage(packageName)
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                return CommandResult(true, "Opened $packageName.", JSONObject().put("package", packageName))
            }
        }

        // Fall back to matching the visible app label.
        val query = raw.lowercase()
        val matches = context.packageManager.getInstalledApplications(0).filter { app ->
            val label = context.packageManager.getApplicationLabel(app).toString().lowercase()
            label.contains(query) && context.packageManager.getLaunchIntentForPackage(app.packageName) != null
        }
        val chosen = matches.minByOrNull { context.packageManager.getApplicationLabel(it).length }
            ?: return CommandResult(false, "I could not find an app matching \"$raw\" on this phone.")

        val intent = context.packageManager.getLaunchIntentForPackage(chosen.packageName)
            ?: return CommandResult(false, "Android would not give me a launch intent for ${chosen.packageName}.")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return CommandResult(
            true,
            "Opened ${context.packageManager.getApplicationLabel(chosen)}.",
            JSONObject().put("package", chosen.packageName),
        )
    }

    private fun openUrl(args: JSONObject): CommandResult {
        var url = args.optString("url").trim()
        if (url.isBlank()) return CommandResult(false, "Which URL should I open?")
        if (!url.startsWith("http")) url = "https://$url"
        return launch(Intent(Intent.ACTION_VIEW, Uri.parse(url)), "Opened $url")
    }

    private fun launchIntent(args: JSONObject): CommandResult {
        val action = args.optString("action", Intent.ACTION_VIEW)
        val uri = args.optString("uri")
        val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (uri.isNotBlank()) intent.data = Uri.parse(uri)
        args.optString("package").takeIf { it.isNotBlank() }?.let { intent.setPackage(it) }
        return launch(intent, "Ran intent $action")
    }

    // ------------------------------------------------------------------- time

    private fun createReminder(args: JSONObject): CommandResult {
        val title = args.optString("title").ifBlank { "Reminder" }
        val whenText = args.optString("when")
        val millis = parseWhen(whenText)
        if (millis == null) {
            return CommandResult(false, "I could not work out when \"$whenText\" is. Try an ISO timestamp like 2026-09-16T08:00:00.")
        }
        val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_MESSAGE, title)
            putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            putExtra(AlarmClock.EXTRA_HOUR, (millis / 3_600_000 % 24).toInt())
            putExtra(AlarmClock.EXTRA_MINUTES, (millis / 60_000 % 60).toInt())
        }
        val fallback = Intent(Intent.ACTION_INSERT).apply {
            type = "vnd.android.cursor.dir/event"
            putExtra(CalendarContract.Events.TITLE, title)
            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, millis)
            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, millis + 15 * 60_000)
        }
        return try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            CommandResult(true, "Alarm set for \"$title\".")
        } catch (notFound: ActivityNotFoundException) {
            launch(fallback, "Reminder \"$title\" created in the calendar app.", requiresNewTask = true)
        }
    }

    private fun createCalendarEvent(args: JSONObject): CommandResult {
        val title = args.optString("title").ifBlank { "Xacheus event" }
        val start = parseWhen(args.optString("when")) ?: System.currentTimeMillis() + 3_600_000
        val intent = Intent(Intent.ACTION_INSERT).apply {
            data = CalendarContract.Events.CONTENT_URI
            putExtra(CalendarContract.Events.TITLE, title)
            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, start + 60 * 60_000)
            args.optString("notes").takeIf { it.isNotBlank() }?.let { putExtra(CalendarContract.Events.DESCRIPTION, it) }
        }
        return launch(intent, "Opened the calendar with \"$title\" ready to save — it needs one confirming tap on the device.", requiresNewTask = true)
    }

    // ---------------------------------------------------------- notifications

    private fun listNotifications(): CommandResult {
        if (!XacheusNotificationListener.isConnected()) {
            return CommandResult(
                false,
                "To read notifications I need the notification-access grant: Settings → Notifications → Device & app notifications → allow Xacheus. Android requires that, and no app can bypass it.",
            )
        }
        val items = XacheusNotificationListener.snapshot()
        val data = JSONObject().put("notifications", org.json.JSONArray(items.map { it.toJson().toString() }))
        return CommandResult(true, "You have ${items.size} notification(s): ${items.take(4).joinToString("; ") { "${it.app}: ${it.title}" }}", data)
    }

    private fun dismissNotifications(): CommandResult {
        if (!XacheusNotificationListener.isConnected()) {
            return CommandResult(false, "Notification access is not granted, so I cannot dismiss anything.")
        }
        val count = XacheusNotificationListener.dismissAll()
        return CommandResult(true, "Dismissed $count notification(s).")
    }

    // ------------------------------------------------------------------ media

    private fun mediaControl(args: JSONObject): CommandResult {
        val action = args.optString("action", "play").lowercase()
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val keyCode = when (action) {
            "play", "resume" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "next", "skip" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "previous", "back" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            "stop" -> KeyEvent.KEYCODE_MEDIA_STOP
            "volumeup", "louder" -> null
            "volumedown", "quieter" -> null
            else -> null
        }
        if (keyCode == null) {
            when (action) {
                "volumeup", "louder" -> {
                    audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
                    return CommandResult(true, "Turned the volume up.")
                }
                "volumedown", "quieter" -> {
                    audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
                    return CommandResult(true, "Turned the volume down.")
                }
            }
            return CommandResult(false, "Unknown media action \"$action\". Try play, pause, next, previous, volumeUp or volumeDown.")
        }
        audio.dispatchMediaKeyEvent(android.view.KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
        audio.dispatchMediaKeyEvent(android.view.KeyEvent(KeyEvent.ACTION_UP, keyCode))
        return CommandResult(
            false,
            "Sent media key \"$action\" to the active player. Android only routes these to a player that is currently running, so check the phone.",
        )
    }

    private fun setSetting(args: JSONObject): CommandResult {
        val name = args.optString("name").lowercase()
        val value = args.optString("value")
        return when (name) {
            "volume" -> {
                val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                val target = if (value.all { it.isDigit() }) value.toInt().coerceIn(0, max) else max / 2
                audio.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI)
                CommandResult(true, "Set media volume to $target of $max.")
            }
            "brightness" -> {
                if (!Settings.System.canWrite(context)) {
                    val intent = Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${context.packageName}"))
                    return launch(intent, "Android needs the \"modify system settings\" grant before I can change brightness — I opened the screen for you.", requiresNewTask = true)
                }
                val level = (value.toIntOrNull() ?: 50).coerceIn(0, 100) * 255 / 100
                Settings.System.putInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS, level)
                CommandResult(true, "Set screen brightness to ${value}%.")
            }
            "airplane" -> CommandResult(false, "Android does not let apps toggle airplane mode; only the device owner UI can.")
            else -> CommandResult(false, "I can change volume and brightness on this build. \"$name\" needs a system grant Android does not give third-party apps.")
        }
    }

    // ----------------------------------------------------------- communication

    private fun call(args: JSONObject): CommandResult {
        val number = args.optString("number")
        val contact = args.optString("contact")
        val target = when {
            number.isNotBlank() -> number
            contact.isNotBlank() -> resolveContact(contact) ?: return CommandResult(false, "I could not find a contact called \"$contact\". Enable contacts access, or give me the number.")
            else -> return CommandResult(false, "Who should I call?")
        }
        val permissionProblem = PermissionGate.ensure(context, listOf(Manifest.permission.CALL_PHONE), "Calling")
        val action = if (permissionProblem == null) Intent.ACTION_CALL else Intent.ACTION_DIAL
        if (permissionProblem != null) {
            val dial = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$target")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(dial)
            return CommandResult(false, "$permissionProblem I opened the dialler with $target so you can press call.")
        }
        val intent = Intent(action, Uri.parse("tel:$target")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return CommandResult(true, "Calling $target.")
    }

    private fun sendSms(args: JSONObject): CommandResult {
        val body = args.optString("body")
        val number = args.optString("number")
        val target = when {
            number.isNotBlank() -> number
            args.optString("contact").isNotBlank() -> resolveContact(args.optString("contact"))
            else -> null
        } ?: return CommandResult(false, "I need a number or a contact name to send an SMS.")
        if (body.isBlank()) return CommandResult(false, "What should the message say?")

        val permissionProblem = PermissionGate.ensure(context, listOf(Manifest.permission.SEND_SMS), "Sending an SMS")
        if (permissionProblem != null) {
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$target")).apply {
                putExtra("sms_body", body)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            return CommandResult(false, "$permissionProblem I opened your messaging app with the text ready so you can press send.")
        }
        @Suppress("DEPRECATION")
        val manager = context.getSystemService(Context.TELEPHONY_SERVICE) as android.telephony.SmsManager
        manager.sendTextMessage(target, null, body, null, null)
        return CommandResult(true, "SMS sent to $target.")
    }

    private fun shareText(args: JSONObject): CommandResult {
        val text = args.optString("text")
        if (text.isBlank()) return CommandResult(false, "Nothing to share.")
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, "Share via").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return CommandResult(true, "Share sheet opened.")
    }

    private fun resolveContact(name: String): String? {
        if (!PermissionGate.granted(context, Manifest.permission.READ_CONTACTS)) {
            PermissionGate.ensure(context, listOf(Manifest.permission.READ_CONTACTS), "Looking up contacts")
            return null
        }
        val cursor = context.contentResolver.query(
            android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
            arrayOf("%$name%"),
            null,
        )
        cursor?.use {
            if (it.moveToFirst()) return it.getString(0)
        }
        return null
    }

    // ---------------------------------------------------------------- capture

    private fun takePhoto(): CommandResult {
        val permissionProblem = PermissionGate.ensure(context, listOf(Manifest.permission.CAMERA), "Taking a photo")
        if (permissionProblem != null) return CommandResult(false, permissionProblem)
        val directory = File(context.cacheDir, "captures").apply { mkdirs() }
        val target = File(directory, "xacheus-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
        val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return launch(intent, "Camera opened — the photo goes to ${target.name} once you take it.", requiresNewTask = true)
    }

    /**
     * Record a short voice note and hand the file back so the backend can store it
     * and index anything it can extract. Recording is time-boxed and visibly
     * indicated by Android's microphone badge.
     */
    private fun recordVoiceNote(args: JSONObject): CommandResult {
        val permissionProblem = PermissionGate.ensure(context, listOf(Manifest.permission.RECORD_AUDIO), "Recording a voice note")
        if (permissionProblem != null) return CommandResult(false, permissionProblem)

        val seconds = args.optInt("seconds", 8).coerceIn(2, 60)
        val file = File(context.cacheDir, "voice-${System.currentTimeMillis()}.m4a")
        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        return try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            recorder.start()
            Thread.sleep(seconds * 1000L)
            recorder.stop()
            recorder.release()
            CommandResult(
                true,
                "Recorded a ${seconds}s voice note (${file.length() / 1024} KB) at ${file.absolutePath}.",
                JSONObject().put("path", file.absolutePath).put("bytes", file.length()),
            )
        } catch (error: Exception) {
            runCatching { recorder.release() }
            CommandResult(false, "Recording failed: ${error.message}")
        }
    }

    // --------------------------------------------------------------- clipboard

    private fun readClipboard(): CommandResult {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        // Android 10+ only exposes the clipboard to the focused app.
        val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()
        return if (text.isNullOrBlank()) {
            CommandResult(false, "The clipboard is empty — or Android is hiding it because the Xacheus app is not in the foreground, which it does by design.")
        } else {
            CommandResult(true, "Clipboard: ${text.take(200)}", JSONObject().put("text", text))
        }
    }

    private fun writeClipboard(args: JSONObject): CommandResult {
        val text = args.optString("text")
        if (text.isBlank()) return CommandResult(false, "What should I copy?")
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Xacheus", text))
        return CommandResult(true, "Copied to the clipboard.")
    }

    // ----------------------------------------------------------------- status

    private fun batteryStatus(): CommandResult {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = manager.isCharging
        return CommandResult(
            true,
            "Battery is at $level%" + if (charging) " and charging." else ".",
            JSONObject().put("level", level).put("charging", charging),
        )
    }

    private fun location(): CommandResult {
        val permissionProblem = PermissionGate.ensure(
            context,
            listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            "Reading your location",
        )
        if (permissionProblem != null) return CommandResult(false, permissionProblem)

        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = when {
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> null
        } ?: return CommandResult(false, "Location services are switched off on this phone.")

        val last = manager.getLastKnownLocation(provider)
            ?: return CommandResult(false, "I have no recent fix yet — location is on, so ask again in a moment.")
        val data = JSONObject()
            .put("latitude", last.latitude)
            .put("longitude", last.longitude)
            .put("accuracy", last.accuracy)
            .put("time", last.time)
        return CommandResult(true, "You are at ${"%.5f".format(last.latitude)}, ${"%.5f".format(last.longitude)} (±${last.accuracy.toInt()} m).", data)
    }

    private fun vibrate(args: JSONObject): CommandResult {
        val millis = args.optLong("millis", 400).coerceIn(50, 5000)
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION") context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        vibrator.vibrate(VibrationEffect.createOneShot(millis, VibrationEffect.DEFAULT_AMPLITUDE))
        return CommandResult(true, "Vibrated for ${millis}ms.")
    }

    private fun torch(args: JSONObject): CommandResult {
        val on = args.optBoolean("on", true)
        val permissionProblem = PermissionGate.ensure(context, listOf(Manifest.permission.CAMERA), "The torch")
        if (permissionProblem != null) return CommandResult(false, permissionProblem)
        val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = cameraManager.cameraIdList.firstOrNull()
            ?: return CommandResult(false, "This device reports no camera, so there is no torch.")
        cameraManager.setTorchMode(cameraId, on)
        return CommandResult(true, "Torch ${if (on) "on" else "off"}.")
    }

    // ----------------------------------------------------------------- helpers

    private fun launch(intent: Intent, successSummary: String, requiresNewTask: Boolean = false): CommandResult {
        if (requiresNewTask) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            CommandResult(true, successSummary)
        } catch (error: ActivityNotFoundException) {
            CommandResult(false, "No app on this phone can handle that action.")
        }
    }

    /** Parse ISO-8601, plus a few forgiving relative phrases. */
    private fun parseWhen(text: String): Long? {
        if (text.isBlank()) return null
        val trimmed = text.trim()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                java.time.Instant.parse(trimmed).toEpochMilli()
            } else null
        } catch (_: Exception) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    java.time.OffsetDateTime.parse(trimmed).toInstant().toEpochMilli()
                } else null
            } catch (_: Exception) {
                val lower = trimmed.lowercase()
                val now = System.currentTimeMillis()
                when {
                    lower.startsWith("in ") -> {
                        val match = Regex("in\\s+(\\d+)\\s*(minute|min|hour|hr|day)").find(lower) ?: return null
                        val amount = match.groupValues[1].toLongOrNull() ?: return null
                        val unit = match.groupValues[2]
                        now + when {
                            unit.startsWith("min") -> amount * 60_000
                            unit.startsWith("hour") || unit == "hr" -> amount * 3_600_000
                            else -> amount * 86_400_000
                        }
                    }
                    else -> null
                }
            }
        }
    }

    companion object {
        private val ALIASES = mapOf(
            "whatsapp" to "com.whatsapp",
            "facebook" to "com.facebook.katana",
            "instagram" to "com.instagram.android",
            "youtube" to "com.google.android.youtube",
            "maps" to "com.google.android.apps.maps",
            "chrome" to "com.android.chrome",
            "gmail" to "com.google.android.gm",
            "camera" to "com.android.camera",
            "settings" to "com.android.settings",
            "calendar" to "com.google.android.calendar",
            "clock" to "com.google.android.deskclock",
            "spotify" to "com.spotify.music",
            "telegram" to "org.telegram.messenger",
            "tiktok" to "com.zhiliaoapp.musically",
            "x" to "com.twitter.android",
            "twitter" to "com.twitter.android",
        )
    }
}
