package dev.pidash.android

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

class GatewayFailure(val status: Int, message: String) : IOException(message)

suspend fun gatewayJson(client: OkHttpClient, pair: Pairing, path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
    val request = Request.Builder().url(pair.url + path).header("Authorization", "Bearer ${pair.token}")
    if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType()))
    client.newCall(request.build()).execute().use { response ->
        val source = response.body?.source() ?: throw IOException("Empty gateway response")
        source.request(1_048_577)
        require(source.buffer.size <= 1_048_576) { "Gateway response too large" }
        val json = JSONObject(source.readUtf8())
        if (!response.isSuccessful) throw GatewayFailure(response.code, json.optString("error", "Gateway request failed").take(500))
        json
    }
}

class GatewayRepository(private val scope: CoroutineScope, private val vault: Vault) {
    private val mutable = MutableStateFlow(Dashboard())
    val state: StateFlow<Dashboard> = mutable
    private val mutablePending = MutableStateFlow<Pending?>(null)
    val pending: StateFlow<Pending?> = mutablePending
    private var pair: Pairing? = null
    private var client: OkHttpClient? = null
    private var foreground = false
    private var monitoring = false
    private var runner: Job? = null
    private var socket: WebSocket? = null
    private var generation = 0
    private val clock: Long get() = System.nanoTime() / 1_000_000

    init {
        try {
            vault.read("pairing")?.let { pair = Pairing.parse(it); client = pair!!.client() }
            vault.read("pending")?.let { val j = JSONObject(it); mutablePending.value = Pending(j.getString("id"), j.getString("epoch"), j.getString("description")) }
        } catch (_: Exception) { mutable.update { it.copy(message = "Stored credentials could not be read. Re-pair this device; any interrupted action has unknown outcome.") } }
        scope.launch {
            while (isActive) {
                delay(1000)
                if (mutable.value.fresh && clock - mutable.value.receivedAt > 15_000) {
                    mutable.update { it.copy(fresh = false, message = "Gateway stale; actions disabled") }
                    socket?.cancel()
                }
            }
        }
    }
    fun host(): String? = pair?.url
    fun foreground(value: Boolean) { foreground = value; lifecycle() }
    fun monitoring(value: Boolean) { monitoring = value; lifecycle() }
    private fun lifecycle() {
        if ((foreground || monitoring) && pair != null && runner?.isActive != true) runner = scope.launch { connectLoop() }
        if (!foreground && !monitoring) {
            generation++; runner?.cancel(); runner = null; socket?.cancel(); socket = null
            mutable.update { it.copy(connected = false, fresh = false) }
        }
    }
    suspend fun pair(document: String) {
        val candidate = Pairing.parse(document)
        val next = candidate.client()
        try {
            val info = gatewayJson(next, candidate, "/api/v1/info")
            require(info.getInt("version") == 1) { "Unsupported gateway version" }
        } catch (error: Exception) { next.connectionPool.evictAll(); next.dispatcher.executorService.shutdown(); throw error }
        generation++; runner?.cancel(); runner = null; socket?.cancel(); socket = null
        client?.connectionPool?.evictAll(); client?.dispatcher?.executorService?.shutdown()
        vault.save("pairing", document)
        pair = candidate; client = next
        // Pairing a different host must not carry a draft or receipt to it.
        vault.save("drafts", null); vault.save("pending", null); mutablePending.value = null
        mutable.value = Dashboard(message = "Paired securely")
        lifecycle()
    }
    fun logout() {
        generation++; runner?.cancel(); runner = null; socket?.cancel(); socket = null
        client?.connectionPool?.evictAll(); client?.dispatcher?.executorService?.shutdown()
        pair = null; client = null; vault.clear(); mutablePending.value = null; mutable.value = Dashboard()
    }
    fun select(id: String?) {
        mutable.update { it.copy(selected = id, detail = null) }
        socket?.send(JSONObject().put("type", "subscribe").put("sessionId", id ?: JSONObject.NULL).toString())
    }
    fun message(text: String) { mutable.update { it.copy(message = text) } }

    private suspend fun connectLoop() {
        var backoff = 1000L
        while (scope.isActive && (foreground || monitoring)) {
            val pair = pair ?: return
            val client = client ?: return
            val current = ++generation
            mutable.update { it.copy(connected = false, fresh = false, message = "Connecting to gateway…") }
            val ended = CompletableDeferred<Pair<Boolean, String>>()
            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (current != generation) { webSocket.cancel(); return }
                    scope.launch { if (current == generation) {
                        socket = webSocket
                        webSocket.send(JSONObject().put("type", "subscribe").put("sessionId", mutable.value.selected ?: JSONObject.NULL).toString())
                    } }
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    scope.launch {
                        if (current != generation) return@launch
                        try {
                            require(text.length <= 1_048_576) { "Gateway frame too large" }
                            val frame = JSONObject(text)
                            mutable.value = reduceFrame(mutable.value, frame, clock)
                            if (frame.getString("type") == "snapshot") {
                                backoff = 1000
                                message("Connected · commands run on the host")
                                if (mutablePending.value != null) scope.launch { reconcile() }
                            }
                            if (frame.getString("type") == "receipt") acceptReceipt(frame.getJSONObject("receipt"))
                        } catch (error: Exception) {
                            ended.complete(false to (error.message ?: "Invalid gateway data")); webSocket.cancel()
                        }
                    }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    ended.complete((response?.code !in listOf(401, 403)) to if (response?.code in listOf(401, 403)) "Pairing rejected or revoked; re-pair" else "Connection lost; reconnecting")
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { ended.complete((code != 4001) to if (code == 4001) "Device revoked; re-pair" else "Disconnected; reconnecting") }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            }
            val ws = client.newWebSocket(Request.Builder().url(pair.url + "/api/v1/events").header("Authorization", "Bearer ${pair.token}").build(), listener)
            val result = try { ended.await() } finally { ws.cancel() }
            if (current != generation) return
            generation++ // Invalidate already queued callbacks from the closed stream.
            socket = null
            mutable.update { it.copy(connected = false, fresh = false, message = result.second) }
            if (!result.first) return
            delay(backoff); backoff = (backoff * 2).coerceAtMost(30_000)
        }
    }
    private suspend fun read(path: String): JSONObject {
        val pair = pair ?: error("Pair with the host first")
        return gatewayJson(client ?: error("No gateway client"), pair, path)
    }
    suspend fun projects(): Projects = Projects.parse(read("/api/v1/projects"))
    suspend fun usage(): UsageReport = UsageReport.parse(read("/api/v1/usage"))
    suspend fun history(project: Project): List<History> = read("/api/v1/projects/${project.id}/sessions").getJSONArray("sessions").objects().map { History(it.getString("id"), it.getString("title"), it.text("blocked")) }
    suspend fun command(target: Session, command: JSONObject) {
        require(target.id == mutable.value.selected) { "Selection changed; review the action again" }
        submit("/api/v1/sessions/${target.id}/commands", JSONObject().put("revision", target.revision).put("command", command), "${command.getString("kind")} · ${target.label}")
    }
    suspend fun launch(project: Project, history: History?) {
        val body = JSONObject().put("projectId", project.id)
        history?.let { body.put("sessionRef", it.id) }
        submit("/api/v1/sessions", body, "${if (history == null) "New" else "Resume"} · ${project.label}")
    }
    private suspend fun submit(path: String, input: JSONObject, description: String) {
        val state = mutable.value
        require(state.fresh && state.connected && state.epoch != null) { "Fresh gateway state is required" }
        require(mutablePending.value == null) { "Reconcile the previous action first" }
        val pending = Pending(UUID.randomUUID().toString(), state.epoch, description)
        // Persist before sending. Cancellation/process death cannot turn an uncertain send into a replay.
        vault.save("pending", JSONObject().put("id", pending.id).put("epoch", pending.epoch).put("description", description).toString())
        mutablePending.value = pending
        input.put("requestId", pending.id).put("epoch", pending.epoch)
        message("Sending $description")
        try {
            val result = gatewayJson(client!!, pair!!, path, input)
            acceptReceipt(result)
            if (mutablePending.value != null) reconcile()
        } catch (error: Exception) {
            if (error is GatewayFailure && error.status in listOf(400, 401, 403, 404, 409, 413, 415, 429)) {
                clearPending(); message("Rejected: ${error.message}")
            } else {
                message("Outcome unknown. Refresh and check receipt; do not resend blindly.")
                if (error is CancellationException) throw error
            }
        }
    }
    private fun acceptReceipt(receipt: JSONObject) {
        val pending = mutablePending.value ?: return
        if (receipt.optString("requestId") != pending.id) return
        when (receipt.getString("state")) {
            "accepted" -> { clearPending(); message("Accepted: ${pending.description}. Completion is shown in session state.") }
            "failed" -> { clearPending(); message("Failed: ${receipt.optString("error", "Rejected by host")}") }
            "unknown" -> message("Outcome unknown: ${pending.description}. Inspect the session before dismissing.")
            "received" -> message("Gateway received ${pending.description}; awaiting acknowledgement")
            else -> error("Invalid receipt state")
        }
    }
    suspend fun reconcile() {
        val pending = mutablePending.value ?: return
        if (pending.epoch != mutable.value.epoch) { message("Gateway restarted; outcome unknown for ${pending.description}. Inspect the session, then dismiss."); return }
        try {
            val receipt = read("/api/v1/commands/${pending.id}")
            if (!receipt.has("requestId")) message("Receipt unavailable; inspect the session before dismissing") else acceptReceipt(receipt)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            message("Cannot retrieve receipt; outcome remains unknown")
        }
    }
    /** Called only after the operator explicitly acknowledges inspecting the actual session. */
    fun clearPending() { vault.save("pending", null); mutablePending.value = null }
}
