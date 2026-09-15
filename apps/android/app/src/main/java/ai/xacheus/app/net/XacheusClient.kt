package ai.xacheus.app.net

import ai.xacheus.app.data.SettingsStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * REST client for the Xacheus backend.
 *
 * Only three calls matter for the phone: ask something (voice), approve/reject a
 * gated action, and upload a file (voice note, photo) into the knowledge base.
 */
class XacheusClient(private val settings: SettingsStore) {

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)   // agent runs and research can take a while
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    data class VoiceReply(val text: String, val awaitingConfirmation: Boolean, val runId: String?)

    fun ask(text: String, sessionId: String): VoiceReply {
        val body = JSONObject().put("text", text).put("sessionId", sessionId)
        val payload = post("/api/voice", body.toString())
        val runId = payload.optJSONObject("run")?.optString("id")
        return VoiceReply(
            text = payload.optString("text", "(no answer)"),
            awaitingConfirmation = payload.optBoolean("awaitingConfirmation", false),
            runId = runId,
        )
    }

    fun confirm(runId: String, stepId: String, approve: Boolean): String {
        val body = JSONObject().put("stepId", stepId).put("approve", approve)
        val payload = post("/api/runs/$runId/confirm", body.toString())
        return payload.optJSONObject("run")?.optString("response") ?: "Done."
    }

    fun pendingRuns(): List<JSONObject> {
        val payload = get("/api/runs/pending")
        val runs = payload.optJSONArray("runs") ?: return emptyList()
        return (0 until runs.length()).mapNotNull { runs.optJSONObject(it) }
    }

    /** Upload a local file so it becomes searchable knowledge. */
    fun uploadFile(file: File, mimeType: String, collection: String = "device"): JSONObject {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", file.name, file.asRequestBody(mimeType.toMediaType()))
            .addFormDataPart("collection", collection)
            .build()
        val request = Request.Builder().url("${settings.serverUrl}/api/documents").post(body).applyAuth().build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("Upload failed: HTTP ${response.code} $text")
            return JSONObject(text)
        }
    }

    fun health(): JSONObject = get("/api/health")

    private fun post(path: String, json: String): JSONObject {
        val request = Request.Builder()
            .url(settings.serverUrl + path)
            .post(json.toRequestBody("application/json".toMediaType()))
            .applyAuth()
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error(describeError(response.code, text))
            return JSONObject(text)
        }
    }

    private fun get(path: String): JSONObject {
        val request = Request.Builder().url(settings.serverUrl + path).applyAuth().build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error(describeError(response.code, text))
            return JSONObject(text)
        }
    }

    private fun Request.Builder.applyAuth(): Request.Builder =
        header("Authorization", "Bearer ${settings.deviceToken}")

    private fun describeError(code: Int, body: String): String = when (code) {
        401 -> "Rejected by the backend (401). Check the device bridge token in Settings — it must match XACHEUS_DEVICE_BRIDGE_TOKEN."
        404 -> "The backend has no such endpoint (404). Is it running the matching version?"
        else -> "Backend error HTTP $code: ${body.take(200)}"
    }
}
