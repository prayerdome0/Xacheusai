package ai.xacheus.app.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/**
 * One-shot speech-to-text used by the push-to-talk microphone button.
 *
 * We use the platform recogniser: it is on-device-capable, respects the user's
 * language and privacy settings, and requires the ordinary RECORD_AUDIO grant.
 * Nothing is recorded to disk here — audio goes to the recogniser the owner's
 * phone is configured with, and only the resulting text leaves the device.
 */
class SpeechEngine(private val context: Context) {

    interface Callback {
        fun onPartial(text: String)
        fun onFinal(text: String)
        fun onError(message: String)
    }

    private var recognizer: SpeechRecognizer? = null

    fun start(callback: Callback) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            callback.onError("This phone has no speech recognition service installed.")
            return
        }
        stop()
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit

                override fun onPartialResults(partialResults: Bundle?) {
                    partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()
                        ?.let(callback::onPartial)
                }

                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    if (text.isBlank()) callback.onError("I did not catch that.") else callback.onFinal(text)
                }

                override fun onError(error: Int) {
                    callback.onError(describe(error))
                }
            })
            startListening(intent())
        }
    }

    fun stop() {
        recognizer?.let {
            runCatching { it.stopListening() }
            runCatching { it.destroy() }
        }
        recognizer = null
    }

    fun intent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        // Bias the recogniser towards the wake word and the product's vocabulary.
        putExtra(
            RecognizerIntent.EXTRA_BIASING_STRINGS,
            arrayListOf("Xacheus", "approve", "decline", "remind me", "send to", "turn on", "turn off"),
        )
    }

    private fun describe(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error."
        SpeechRecognizer.ERROR_CLIENT -> "Recogniser client error."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is missing."
        SpeechRecognizer.ERROR_NETWORK -> "The recogniser needs a network connection right now."
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "The recogniser timed out."
        SpeechRecognizer.ERROR_NO_MATCH -> "I did not catch that — try again."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The recogniser is busy; give it a second."
        SpeechRecognizer.ERROR_SERVER -> "The speech service returned an error."
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "I heard nothing."
        else -> "Speech recognition failed (code $error)."
    }
}
