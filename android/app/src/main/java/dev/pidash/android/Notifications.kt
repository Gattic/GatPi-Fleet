package dev.pidash.android

/** The notification channels and ids this app owns. */
object Channels {
    const val MONITOR = "monitoring"
    const val ATTENTION = "attention"
    const val FOREGROUND_ID = 1

    /** One stable id per session, so a new attention replaces that session's earlier notification and never the service's. */
    fun attentionId(sessionId: String): Int = 2 + (sessionId.hashCode() and 0x7fffffff) % 1_000_000
}

/** Sessions whose attention notification appeared, and sessions whose notification should go. */
data class AttentionUpdate(val alerts: List<Session>, val cleared: List<String>)

/**
 * Turns the dashboard's attention keys into per-session notifications. A first fresh snapshot and every
 * reconnect only seed the baseline: the backlog of sessions already needing you is not replayed, and a
 * session is announced once per attention key until it stops needing you.
 */
class AttentionNotifier {
    /** Attention key already announced per session. Kept across reconnects so cleared notifications can be withdrawn. */
    private val announced = mutableMapOf<String, String>()
    private var seeded = false

    /** Forgets the baseline and returns the sessions whose notifications should be cancelled. */
    fun reset(): List<String> {
        val ids = announced.keys.toList()
        announced.clear()
        seeded = false
        return ids
    }

    fun update(state: Dashboard): AttentionUpdate {
        // A connection loss is not evidence that a session stopped needing you; keep what was announced.
        if (!state.fresh) { seeded = false; return AttentionUpdate(emptyList(), emptyList()) }
        val current = state.sessions.mapNotNull { session -> session.attentionKey?.let { session.id to it } }.toMap()
        val alerts = if (seeded) state.sessions.filter { it.attentionKey != null && announced[it.id] != it.attentionKey } else emptyList()
        val cleared = announced.keys.filter { it !in current }
        seeded = true
        announced.clear()
        announced.putAll(current)
        return AttentionUpdate(alerts, cleared)
    }
}
