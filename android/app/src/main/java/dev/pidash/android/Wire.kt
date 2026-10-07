package dev.pidash.android

import org.json.JSONArray
import org.json.JSONObject

fun JSONObject.text(key: String): String? = if (isNull(key)) null else getString(key)
fun JSONObject.number(key: String): Double? = if (isNull(key)) null else getDouble(key)
fun JSONArray.objects(): List<JSONObject> = (0 until length()).map(::getJSONObject)

data class Plan(val title: String, val complete: Int, val total: Int, val active: String)
data class Metrics(val cpu: Double, val memory: Double, val gpuMemory: Double?)
data class Session(
    val id: String, val revision: String, val label: String, val project: String,
    val status: String, val statusLabel: String, val since: Long?, val attentionKey: String?,
    val connected: Boolean, val model: String?, val thinking: String?, val contextPercent: Double?,
    val plan: Plan?, val metrics: Metrics?, val tokens: Double?, val cost: Double?,
    val commands: Map<String, String?>,
) {
    /** A run is in progress, so a prompt must be delivered as a steer or follow-up. */
    val running: Boolean get() = status in listOf("working", "stalled", "rate-limited")

    companion object {
        fun parse(j: JSONObject): Session {
            val status = j.getJSONObject("status")
            val p = j.optJSONObject("plan")
            val r = j.optJSONObject("resources")
            val u = j.optJSONObject("usage")
            val commands = j.getJSONObject("commands")
            return Session(j.getString("id"), j.getString("revision"), j.getString("label"), j.text("project") ?: "Unknown project",
                status.getString("kind"), status.getString("label"), status.number("since")?.toLong(), j.text("attentionKey"),
                j.getBoolean("connected"), j.text("model"), j.text("thinking"), j.number("contextPercent"),
                p?.let { Plan(it.getString("title"), it.getInt("complete"), it.getInt("total"), it.text("active") ?: "") },
                r?.let { Metrics(it.getDouble("cpu"), it.getDouble("memory"), it.number("gpuMemory")) }, u?.number("tokens"), u?.number("cost"),
                commands.keys().asSequence().associateWith { commands.text(it) })
        }
    }
}
data class Ask(val id: Int, val question: String, val answer: String, val status: String, val error: String?, val cost: Double?)
data class Tool(val name: String, val detail: String, val running: Boolean, val failed: Boolean)
data class Detail(val session: Session, val prompt: String?, val reply: String?, val suggestion: String?, val error: String?, val models: List<String>, val asks: List<Ask>, val tools: List<Tool>) {
    companion object {
        fun parse(j: JSONObject) = Detail(Session.parse(j), j.text("lastPrompt"), j.text("lastSaid"), j.text("suggestion"), j.text("error"),
            j.getJSONArray("models").let { a -> (0 until a.length()).map(a::getString) },
            j.getJSONArray("asks").objects().map { Ask(it.getInt("id"), it.getString("question"), it.getString("answer"), it.getString("status"), it.text("error"), it.number("cost")) },
            j.getJSONArray("tools").objects().map { Tool(it.getString("name"), it.getString("detail"), it.isNull("endedAt"), it.getBoolean("isError")) })
    }
}
data class Project(val id: String, val label: String, val path: String)
data class History(val id: String, val title: String, val blocked: String?)
data class Pending(val id: String, val epoch: String, val description: String)
data class Dashboard(
    val sessions: List<Session> = emptyList(), val selected: String? = null, val detail: Detail? = null,
    val epoch: String? = null, val seq: Long = 0, val connected: Boolean = false, val fresh: Boolean = false,
    val receivedAt: Long = 0, val updatedAt: Long = 0, val message: String = "Pair with your host to begin",
)

/** No side effects; sequence gaps or schema mismatches require a new complete snapshot. */
fun reduceFrame(old: Dashboard, frame: JSONObject, now: Long): Dashboard {
    require(frame.getInt("version") == 1) { "Unsupported gateway API; update the app and host together" }
    val epoch = frame.getString("epoch")
    val seq = frame.getLong("seq")
    val type = frame.getString("type")
    if (old.epoch != epoch || !old.connected) require(type == "snapshot" && seq == 1L) { "Expected a fresh snapshot" }
    else require(seq == old.seq + 1) { "Event gap; resynchronising" }
    var state = old.copy(epoch = epoch, seq = seq, connected = true, fresh = true, receivedAt = now, updatedAt = frame.getLong("at"))
    when (type) {
        "snapshot" -> {
            val sessions = frame.getJSONArray("sessions").objects().map(Session::parse)
            val selected = old.selected?.takeIf { id -> sessions.any { it.id == id } }
            state = state.copy(sessions = sessions, selected = selected, detail = old.detail?.takeIf { it.session.id == selected && old.epoch == epoch })
        }
        "detail" -> if (frame.getString("id") == old.selected) state = state.copy(detail = frame.optJSONObject("detail")?.let(Detail::parse))
        "heartbeat", "receipt" -> Unit
        else -> error("Unknown event type")
    }
    return state
}
