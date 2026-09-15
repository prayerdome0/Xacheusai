package ai.xacheus.app.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale
import java.util.UUID

/** Text-to-speech, initialised lazily so the app never blocks on the engine. */
class Speaker(private val context: Context) {

    private var engine: TextToSpeech? = null
    private var ready = false
    private val queued = ArrayDeque<String>()

    /** Speak [text], replacing anything still being spoken. */
    fun say(text: String) {
        if (text.isBlank()) return
        val tts = engine ?: create()
        if (tts == null) return

        if (!ready) {
            // The engine reports readiness asynchronously; hold the text and speak
            // it as soon as initialisation finishes.
            queued.addLast(text)
            return
        }
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, UUID.randomUUID().toString())
    }

    private fun create(): TextToSpeech? = try {
        val tts = TextToSpeech(context) { status ->
            ready = status == TextToSpeech.SUCCESS
            val engine = this.engine
            if (ready && engine != null) {
                engine.language = Locale.getDefault()
                while (queued.isNotEmpty()) {
                    val pending = queued.removeFirst()
                    engine.speak(pending, TextToSpeech.QUEUE_ADD, null, UUID.randomUUID().toString())
                }
            }
        }
        engine = tts
        tts
    } catch (error: Exception) {
        null
    }

    fun stop() {
        engine?.stop()
    }

    fun shutdown() {
        engine?.shutdown()
        engine = null
        ready = false
        queued.clear()
    }
}
