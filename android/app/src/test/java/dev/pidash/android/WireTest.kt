package dev.pidash.android

import dev.pidash.g1.TextPager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WireTest {
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResource("snapshot.json")!!.readText())
    @Test fun readsTheActualHostFixtureAndPreservesUnknownMetrics() {
        val state = reduceFrame(Dashboard(), fixture(), 10)
        assertTrue(state.fresh)
        assertEquals(1, state.sessions.size)
        assertEquals("project", state.sessions.single().label)
        assertNull(state.sessions.single().metrics)
        assertNull(state.sessions.single().contextPercent)
        assertTrue(state.sessions.single().commands.containsKey("prompt"))
    }
    @Test fun rejectsOutOfOrderFramesAndIncompatibleVersions() {
        val initial = fixture()
        val state = reduceFrame(Dashboard(), initial, 1)
        assertThrows(IllegalArgumentException::class.java) { reduceFrame(state, initial, 2) }
        assertThrows(IllegalArgumentException::class.java) { reduceFrame(Dashboard(), fixture().put("version", 99), 2) }
        assertThrows(IllegalArgumentException::class.java) { reduceFrame(state, fixture().put("epoch", "new").put("type", "heartbeat"), 2) }
    }
    @Test fun aReconnectReplacesTheOverviewRatherThanKeepingGhostSessions() {
        val state = reduceFrame(Dashboard(), fixture(), 1)
        val empty = fixture().put("sessions", org.json.JSONArray())
        val resumed = reduceFrame(state.copy(connected = false), empty, 2)
        assertTrue(resumed.sessions.isEmpty())
    }
    @Test fun attentionAlertsAreTransitionsNotSnapshotOrReconnectReplay() {
        val state = reduceFrame(Dashboard(), fixture(), 1)
        val policy = AttentionPolicy()
        val alert = state.sessions.single().copy(attentionKey = "first", since = 1)
        assertNull(policy.next(state, true, 0))
        val changed = state.copy(sessions = listOf(alert))
        assertEquals(alert, policy.next(changed, true, 100))
        assertNull(policy.next(changed, true, 200))
        assertNull(policy.next(changed.copy(fresh = false), true, 300))
        assertNull(policy.next(changed, true, 40_000))
        assertNotNull(policy.next(changed.copy(sessions = listOf(alert.copy(attentionKey = "second"))), true, 41_000))
    }
    @Test fun cardsKeepFreshnessWithinFiveLinesAndBoundExcerpts() {
        val cards = GlassesCards(TextPager({ it.length * 12f }))
        val state = reduceFrame(Dashboard(), fixture(), 1)
        val long = state.sessions.single().copy(label = "a very long project name ".repeat(20))
        val text = cards.session(state.copy(sessions = listOf(long), fresh = false), long.id).single()
        assertEquals(5, text.trimEnd().lines().size)
        assertTrue(text.contains("OFFLINE"))
        assertEquals(3, cards.excerpt("long reply ".repeat(500)).size)
        assertEquals("Cafe -> ?", g1Text("Café → 中"))
        assertFalse(text.contains("\u001b"))
    }
}
