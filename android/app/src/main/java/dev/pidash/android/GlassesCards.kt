package dev.pidash.android

import dev.pidash.g1.TextPager
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun g1Text(text: String): String {
    val replaced = text.replace('“', '"').replace('”', '"').replace('‘', '\'').replace('’', '\'')
        .replace("—", "-").replace("–", "-").replace("→", "->").replace("…", "...").replace("·", "|")
    return Normalizer.normalize(replaced, Normalizer.Form.NFKD).replace(Regex("\\p{Mn}+"), "").replace(Regex("[^\\x20-\\x7E\\n]"), "?")
}

class GlassesCards(private val pager: TextPager) {
    // One logical field per lens line. Long project names must not push freshness off the screen.
    private fun card(lines: List<String>): List<String> = listOf(lines.take(5).joinToString("\n", postfix = "\n") { line ->
        val wrapped = pager.lines(g1Text(line))
        val first = wrapped.firstOrNull().orEmpty()
        if (wrapped.size > 1 && first.length > 3) first.dropLast(3) + "..." else first
    })
    fun overview(state: Dashboard): List<String> {
        val alerts = state.sessions.filter { it.attentionKey != null }.sortedBy { it.since ?: Long.MAX_VALUE }
        return card(listOf("PI DASH | ${state.sessions.size} sessions", "${alerts.size} need attention", "${state.sessions.count { it.status == "working" }} working",
            alerts.firstOrNull()?.let { "Oldest: ${it.label}" } ?: "No attention alerts", freshness(state)))
    }
    fun session(state: Dashboard, id: String): List<String> {
        val session = state.sessions.find { it.id == id } ?: return card(listOf("SESSION UNAVAILABLE", "Choose another on phone", freshness(state)))
        return card(listOf("${session.label} | ${session.statusLabel}", session.plan?.active?.takeIf { it.isNotBlank() } ?: session.model ?: "No activity detail",
            session.plan?.let { "Plan: ${it.complete}/${it.total} complete" } ?: "No active roadmap",
            "CTX ${session.contextPercent?.toInt()?.toString() ?: "?"}% | CPU ${session.metrics?.cpu?.times(100)?.toInt()?.toString() ?: "?"}%", freshness(state)))
    }
    fun attention(state: Dashboard, session: Session): List<String> = card(listOf("PI DASH | ATTENTION", session.label, session.statusLabel,
        session.since?.let { "Waiting ${((System.currentTimeMillis() - it).coerceAtLeast(0) / 60_000)}m" } ?: "Check on phone", freshness(state)))
    fun excerpt(reply: String): List<String> = pager.pages("REPLY EXCERPT\n" + g1Text(reply)).take(3)
    private fun freshness(state: Dashboard): String = if (!state.fresh) "OFFLINE | last ${time(state.updatedAt)}" else "Updated ${time(state.updatedAt)}"
    private fun time(at: Long): String = if (at == 0L) "unknown" else Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("HH:mm"))
}

/** Seed on initial/reconnected snapshot: alert transitions, never an old reconnect backlog. */
class AttentionPolicy {
    private var previous: Set<String>? = null
    private var lastAlert = Long.MIN_VALUE / 2
    fun next(state: Dashboard, enabled: Boolean, now: Long): Session? {
        if (!state.fresh) { previous = null; return null }
        val keys = state.sessions.mapNotNull { it.attentionKey }.toSet()
        val old = previous
        previous = keys
        if (!enabled || old == null || now - lastAlert < 30_000) return null
        val session = state.sessions.filter { it.attentionKey != null && it.attentionKey !in old }.minByOrNull { it.since ?: Long.MAX_VALUE }
        if (session != null) lastAlert = now
        return session
    }
}
