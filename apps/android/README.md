# Xacheus Android — the phone bridge

The companion app that turns the Xacheus backend into something you can talk to and
that can act on your phone. It is deliberately a **thin, explicit client**:

- it dials **out** to the backend over a WebSocket, so there are no inbound ports,
  no listening server on your handset, and Android stays in charge of battery and
  privacy;
- every device action is a **named command** the app implements and Android
  permission-checks. Xacheus cannot bypass a system prompt, a battery optimisation
  or a privacy switch — it can only ask;
- the wake word runs in a **foreground service with a permanently visible
  notification**. It is never hidden listening.

---

## What it does

| Area | Commands |
| --- | --- |
| Apps & web | `device.openApp`, `device.openUrl`, `device.launchIntent` |
| Time & tasks | `device.createReminder`, `device.createCalendarEvent` |
| Notifications | `device.listNotifications`, `device.dismissNotifications` |
| Media | `device.mediaControl` (play/pause/next/previous/volume) |
| Device | `device.info`, `device.setSetting`, `device.batteryStatus`, `device.torch`, `device.vibrate` |
| Communication | `device.call`, `device.sendSms`, `device.shareText` |
| Capture | `device.takePhoto`, `device.recordVoiceNote` |
| Context | `device.location`, `device.readClipboard`, `device.writeClipboard` |
| Output | `device.speak` |

On the phone side these map to intents, Telephony, SmsManager, MediaSession key
events, CameraX/Camera2 intents, ClipboardManager, FusedLocation or
LocationManager, and the TextToSpeech engine.

---

## Build it

1. Install **Android Studio** (Koala or newer) with an Android 14 (API 34) SDK.
2. Open the `apps/android` folder as a project.
3. Let Gradle sync (it will download the Android Gradle Plugin, Kotlin, Compose
   and OkHttp — the first sync needs internet access).
4. Run it on a device or emulator (API 26+; wake-word service needs API 26+,
   foreground-service microphone type needs API 34 to be declared, which it is).

The Gradle wrapper JAR is intentionally not committed (binary); Android Studio
generates it on first sync. From a terminal you can also run:

```bash
cd apps/android
gradle wrapper --gradle-version 8.9   # once, if you don't use Android Studio
./gradlew assembleDebug
```

---

## Pair it with your backend

1. Start the backend (see the repository README).
2. In the backend `.env`, set a long random `XACHEUS_DEVICE_BRIDGE_TOKEN`.
3. Make sure the phone can reach the backend:
   - same Wi-Fi → use your computer's LAN IP, e.g. `http://192.168.1.20:8787`
   - anywhere → put the backend behind HTTPS (Cloudflare Tunnel, Tailscale
     Funnel, ngrok…) and use that URL
4. Open the app → **Settings** → fill in:
   - **Server URL** (e.g. `http://192.168.1.20:8787`)
   - **Device bridge token** (the same value as in `.env`)
   - **Device name** (e.g. "Pixel 8")
5. Tap **Connect**. The app generates a stable device id, opens the WebSocket and
   the backend shows it under *Connect → Devices*.
6. Tap **Start listening** to run the wake-word foreground service.

Once paired you can say:

> “Xacheus, open WhatsApp.”
> “Xacheus, remind me tomorrow morning to check the website.”
> “Xacheus, what's my battery?”

…and the reply is spoken on the phone.

---

## Permissions, and why each one is asked for

| Permission | Needed for | When it is requested |
| --- | --- | --- |
| `INTERNET` | talking to your backend | install time |
| `RECORD_AUDIO` | wake word + speech recognition | when you tap **Start listening** |
| `POST_NOTIFICATIONS` | the foreground notification + replies | on first launch (API 33+) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` | always-available wake word that Android allows | when the service starts |
| `CALL_PHONE` | `device.call` | first time a call is requested |
| `SEND_SMS` | `device.sendSms` | first time an SMS is requested |
| `CAMERA` | `device.takePhoto`, `device.torch` | first time it is requested |
| `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | `device.location` | first time it is requested |
| `VIBRATE` | `device.vibrate` | install time |
| `SET_ALARM` | `device.createReminder` (clock alarms) | install time |
| `READ_CALENDAR` / `WRITE_CALENDAR` | `device.createCalendarEvent` | first time it is requested |

If a permission is denied, the app replies to the backend with
`ok: false` and a message that says which permission is missing. Xacheus reports
that honestly instead of pretending the action worked.

---

## Wake word: what is realistic

**Implemented here:** a continuous on-device `SpeechRecognizer` loop inside a
foreground service. It works offline on most devices with Google's recogniser, it
shows a permanent notification while the microphone is held, and it stops the
moment you stop the service.

**Trade-offs you should know about:** continuous recognition costs battery, and
it is not as accurate as a purpose-built wake-word engine.

**If you want a production-grade wake word**, plug one in behind
`WakeWordEngine`:

- **Picovoice Porcupine** (free tier, custom "Xacheus" keyword, fully offline) —
  replace `SpeechLoopEngine` with a `PorcupineEngine`.
- **Vosk / snowboy-style small models** — same interface.
- **Android's own `VoiceInteractionService`** — makes Xacheus the device
  assistant, so the system wake word ("Hey Google") hands off to it.

The interface is one file (`voice/WakeWordEngine.kt`), so swapping engines does not
touch the rest of the app.

---

## Files

```
app/src/main/java/ai/xacheus/app/
├── XacheusApp.kt              application, notification channels
├── MainActivity.kt            Compose shell: chat, status, settings
├── data/SettingsStore.kt      SharedPreferences pairing + preferences
├── net/XacheusClient.kt       REST: /api/voice, /api/chat, /api/runs/:id/confirm
├── net/DeviceSocket.kt        WebSocket to /api/devices/socket, command loop
├── device/DeviceCommands.kt   the actual Android actions
├── device/PermissionGate.kt   runtime permission requests with honest results
├── voice/WakeWordEngine.kt    engine interface + continuous recogniser loop
├── voice/SpeechEngine.kt      one-shot speech-to-text for the mic button
├── voice/Speaker.kt           text-to-speech
├── voice/WakeWordService.kt   the foreground service
└── ui/                        Compose screens and theme
```

Nothing in this app phone-homes anywhere except **your** backend URL.
