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
/** [host] is a remote host of the gateway's pi-dash, or null for the gateway's own machine. */
data class Project(val id: String, val host: String?, val label: String, val path: String) {
    /** The directory as pi-dash shows it: `host:/path` on a remote host. */
    val location: String get() = host?.let { "$it:$path" } ?: path
}
data class Unreachable(val host: String, val error: String)
/** New/resume choices: the projects of every host that answered, and the hosts that did not. */
data class Projects(val projects: List<Project>, val unreachable: List<Unreachable>) {
    companion object {
        fun parse(j: JSONObject) = Projects(
            j.getJSONArray("projects").objects().map { Project(it.getString("id"), it.text("host"), it.getString("label"), it.getString("path")) },
            j.getJSONArray("unreachable").objects().map { Unreachable(it.getString("host"), it.getString("error")) },
        )
    }
}
data class History(val id: String, val title: String, val blocked: String?)

/** What usage is measured in: pi's API-equivalent cost, or tokens (the only measure for models without a price). */
enum class Metric { Cost, Tokens }
/** A session's ([open] while it runs) or a model's usage in one measure. */
data class UsageItem(val label: String, val value: Double, val open: Boolean = false)
/** Usage in one measure over a range: per chart bucket (oldest first), and the largest sessions and models. */
data class UsageMeasure(val series: List<Double>, val sessions: List<UsageItem>, val models: List<UsageItem>) {
    companion object {
        fun parse(j: JSONObject) = UsageMeasure(
            j.getJSONArray("series").let { a -> (0 until a.length()).map(a::getDouble) },
            j.getJSONArray("sessions").objects().map { UsageItem(it.getString("label"), it.getDouble("value"), it.getBoolean("open")) },
            j.getJSONArray("models").objects().map { UsageItem(it.getString("name"), it.getDouble("value")) },
        )
    }
}
/** [range] is "today", "7d" or "30d"; [cacheHit] is the part of prompt tokens read from the provider's cache. */
data class UsageRange(val range: String, val bucketHours: Int, val cost: Double, val tokens: Double, val cacheHit: Double, val costs: UsageMeasure, val tokenCounts: UsageMeasure) {
    fun total(metric: Metric): Double = if (metric == Metric.Cost) cost else tokens
    fun measure(metric: Metric): UsageMeasure = if (metric == Metric.Cost) costs else tokenCounts
    companion object {
        fun parse(j: JSONObject): UsageRange {
            val total = j.getJSONObject("total")
            return UsageRange(j.getString("range"), j.getInt("bucketHours"), total.getDouble("cost"), total.getDouble("tokens"), total.getDouble("cacheHit"),
                UsageMeasure.parse(j.getJSONObject("cost")), UsageMeasure.parse(j.getJSONObject("tokens")))
        }
    }
}
/** A session's estimated part of a quota window. */
data class QuotaShare(val label: String, val open: Boolean, val share: Double)
/** A subscription quota window (e.g. 5h, wk) of one provider login; times are host epoch milliseconds. */
data class Quota(val provider: String, val window: String, val usedPercent: Double, val resetAt: Long?, val exhaustedUntil: Long?, val shares: List<QuotaShare>)
/** The host's usage view as of [at] (host epoch milliseconds); [indexing] while its first scan of session files runs. */
data class UsageReport(val at: Long, val indexing: Boolean, val quota: List<Quota>, val ranges: List<UsageRange>) {
    fun range(id: String): UsageRange = ranges.first { it.range == id }
    companion object {
        val RANGES = listOf("today", "7d", "30d")
        fun parse(j: JSONObject): UsageReport {
            val ranges = j.getJSONArray("ranges").objects().map(UsageRange::parse)
            require(ranges.map { it.range } == RANGES) { "Unsupported usage ranges" }
            return UsageReport(j.getLong("at"), j.getBoolean("indexing"),
                j.getJSONArray("quota").objects().map { q ->
                    Quota(q.getString("provider"), q.getString("window"), q.getDouble("usedPercent"), q.number("resetAt")?.toLong(), q.number("exhaustedUntil")?.toLong(),
                        q.getJSONArray("shares").objects().map { QuotaShare(it.getString("label"), it.getBoolean("open"), it.getDouble("share")) })
                },
                ranges)
        }
    }
}
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
