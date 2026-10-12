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
    @Test fun readsTheActualHostUsageFixture() {
        val usage = UsageReport.parse(JSONObject(javaClass.classLoader!!.getResource("usage.json")!!.readText()))
        assertFalse(usage.indexing)
        val accounts = usage.quota!!
        assertEquals(listOf("anthropic", "codex"), accounts.map { it.provider })
        assertEquals(listOf("fresh", "stale"), accounts.map { it.status })
        assertEquals(listOf(25.0, 57.0), accounts[0].windows.map { it.usedPercent })
        assertEquals(listOf("5h", "7d"), accounts[0].windows.map { it.label })
        assertTrue(accounts[0].fresh(usage.at))
        assertFalse(accounts[0].fresh(accounts[0].freshUntil!!))
        assertFalse(accounts[1].fresh(usage.at))
        assertEquals("Usage endpoint HTTP 429", accounts[1].message)
        assertEquals(listOf(AccountCooldown("anthropic", usage.at + 3_600_000L)), usage.cooldowns)
        val week = usage.range("7d")
        assertEquals(6, week.bucketHours)
        assertEquals(listOf(UsageItem("pi-dash", 3.25, open = true)), week.measure(Metric.Cost).sessions)
        assertEquals(listOf("site › Fix the header", "pi-dash"), week.measure(Metric.Tokens).sessions.map { it.label })
        assertEquals(listOf(UsageItem("gpt-6", 6e6), UsageItem("claude-opus", 2.1e6)), week.measure(Metric.Tokens).models)
        assertEquals(8.1e6, week.total(Metric.Tokens), 0.0)
        assertEquals(3.0, usage.range("today").measure(Metric.Cost).series.last(), 0.0)
    }
    @Test fun unavailableAccountStateIsNotAnEmptyCooldownList() {
        val json = JSONObject(javaClass.classLoader!!.getResource("usage.json")!!.readText())
        json.put("quota", JSONObject.NULL)
        json.put("cooldowns", JSONObject.NULL)
        val unknown = UsageReport.parse(json)
        assertNull(unknown.quota)
        assertNull(unknown.cooldowns)
        json.put("cooldowns", org.json.JSONArray())
        assertEquals(emptyList<AccountCooldown>(), UsageReport.parse(json).cooldowns)
    }
    @Test fun missingAndInvalidQuotaDataNeverLooksAvailable() {
        val json = JSONObject(javaClass.classLoader!!.getResource("usage.json")!!.readText())
        val first = json.getJSONArray("quota").getJSONObject(0)
        first.getJSONArray("windows").getJSONObject(0).put("usedPercent", 101)
        assertThrows(IllegalArgumentException::class.java) { UsageReport.parse(json) }
        first.put("windows", org.json.JSONArray())
        assertThrows(IllegalArgumentException::class.java) { UsageReport.parse(json) }
        first.put("status", "unknown").put("fetchedAt", JSONObject.NULL).put("freshUntil", JSONObject.NULL)
        val unknown = UsageReport.parse(json).quota!!.first()
        assertTrue(unknown.windows.isEmpty())
        assertFalse(unknown.fresh(0))
        json.put("quota", org.json.JSONArray())
        assertEquals(emptyList<QuotaAccount>(), UsageReport.parse(json).quota)
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
