package ai.xacheus.app.voice

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * Wake-word detection behind a one-method interface, so you can swap engines
 * without touching the rest of the app.
 *
 * The default implementation is [SpeechLoopEngine]: a continuous loop of the
 * platform recogniser that looks for an utterance starting with the wake word.
 * It is honest about its cost — continuous recognition uses battery, and Android
 * shows the microphone indicator for as long as it runs.
 *
 * Better options, all compatible with this interface:
 *   • Picovoice Porcupine — a custom "Xacheus" keyword, fully offline, low power.
 *   • A small Vosk model.
 *   • Android's VoiceInteractionService, handing off from the system assistant.
 */
interface WakeWordEngine {
    /** Begin listening. [onWake] fires with the full utterance after the wake word. */
    fun start(onWake: (utterance: String) -> Unit, onError: (String) -> Unit)

    fun stop()

    val isRunning: Boolean
}

/**
 * Continuous-recognition wake word loop.
 *
 * Design choices worth knowing:
 *  - we restart the recogniser after each result or error, with a short pause so
 *    the phone is not permanently hot;
 *  - only utterances whose first word matches the wake word are reported, so
 *    ordinary conversation does not trigger Xacheus;
 *  - if recognition is unavailable the engine reports that to the service, which
 *    shows it in the notification instead of failing silently.
 */
class SpeechLoopEngine(
    private val context: Context,
    private val wakeWord: () -> String,
) : WakeWordEngine {

    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var running = false

    // Kept as fields so automatic restarts keep reporting to the same listeners.
    private var onWakeHandler: ((String) -> Unit) = {}
    private var onErrorHandler: ((String) -> Unit) = {}

    override val isRunning: Boolean get() = running

    override fun start(onWake: (String) -> Unit, onError: (String) -> Unit) {
        if (running) return
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onError("No speech recognition service on this phone, so the wake word cannot run.")
            return
        }
        onWakeHandler = onWake
        onErrorHandler = onError
        running = true
        listen()
    }

    override fun stop() {
        running = false
        handler.removeCallbacksAndMessages(null)
        stopRecognizer()
    }

    private fun stopRecognizer() {
        recognizer?.let {
            runCatching { it.stopListening() }
            runCatching { it.destroy() }
        }
        recognizer = null
    }

    private fun listen() {
        if (!running) return
        stopRecognizer()

        val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
        this.recognizer = recognizer

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit

            override fun onPartialResults(partialResults: Bundle?) {
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                maybeWake(text, onWakeHandler)
            }

            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (!maybeWake(text, onWakeHandler)) restart()
            }

            override fun onError(error: Int) {
                when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                        onErrorHandler("Microphone permission was revoked, so wake-word listening stopped.")
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> restart(600)
                    else -> restart()
                }
            }
        })

        runCatching { recognizer.startListening(wakeIntent()) }
            .onFailure {
                Log.w(TAG, "startListening failed: ${it.message}")
                restart(1_500)
            }
    }

    /** Returns true when the utterance contained the wake word. */
    private fun maybeWake(text: String, onWake: (String) -> Unit): Boolean {
        if (text.isBlank()) return false
        val wake = wakeWord()
        val normalized = text.trim().lowercase()
        if (!normalized.startsWith(wake)) return false

        val rest = text.trim().substring(minOf(wake.length, text.trim().length)).trim().trimStart(',', '.', ':')
        onWake(rest.ifBlank { "" })
        return true
    }

    private fun restart(delayMillis: Long = 250) {
        if (!running) return
        handler.postDelayed({ listen() }, delayMillis)
    }

    private fun wakeIntent() = android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 800L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 800L)
        putExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, arrayListOf(wakeWord(), "approve", "decline", "turn off"))
    }

    companion object {
        private const val TAG = "XacheusWake"
    }
}
