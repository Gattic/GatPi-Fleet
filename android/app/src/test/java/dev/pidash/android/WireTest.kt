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
        assertEquals(listOf(0.0, 57.0), accounts[0].windows.map { it.usedPercent })
        assertEquals(listOf("5h", "7d"), accounts[0].windows.map { it.label })
        assertNull(accounts[0].windows[0].resetAt)
        assertNotNull(accounts[0].windows[1].resetAt)
        assertEquals(listOf("7d"), accounts[1].windows.map { it.label })
        assertTrue(accounts[0].fresh(usage.at))
        assertFalse(accounts[0].fresh(accounts[0].freshUntil!!))
        assertFalse(accounts[1].fresh(usage.at))
        assertEquals("Usage endpoint HTTP 429", accounts[1].message)
        assertEquals(listOf(AccountCooldown("anthropic", usage.at + 3_600_000L)), usage.cooldowns)
        val week = usage.range("7d")
        assertEquals(6, week.bucketHours)
        assertEquals(listOf(UsageItem("pi-dash", 3.25, open = true), UsageItem("train@box00", 1.5, open = true), UsageItem("notes@boxhome › Release notes", 0.75)), week.measure(Metric.Cost).sessions)
        assertEquals(listOf("site › Fix the header", "pi-dash", "train@box00 › Evaluate the run", "train@box00", "notes@boxhome › Release notes"), week.measure(Metric.Tokens).sessions.map { it.label })
        assertEquals(listOf(UsageItem("gpt-6", 8e6), UsageItem("claude-opus", 3.6e6)), week.measure(Metric.Tokens).models)
        assertEquals(11.6e6, week.total(Metric.Tokens), 0.0)
        assertEquals(4.5, usage.range("today").measure(Metric.Cost).series.last(), 0.0)
    }
    @Test fun readsEachRemoteHostsUsageAndSaysWhichAreIncomplete() {
        val usage = UsageReport.parse(JSONObject(javaClass.classLoader!!.getResource("usage.json")!!.readText()))
        assertEquals(listOf(RemoteUsageHost("box00", "online", false), RemoteUsageHost("boxhome", "offline", false)), usage.hosts)
        assertEquals(listOf<String?>(null, "offline"), usage.hosts.map { it.gap })
        assertEquals(listOf(HostUsage(null, 3.25), HostUsage("box00", 1.5), HostUsage("boxhome", 0.0)), usage.range("today").measure(Metric.Cost).hosts)
        assertEquals(listOf(HostUsage(null, 8.1e6), HostUsage("box00", 3e6), HostUsage("boxhome", 5e5)), usage.range("7d").measure(Metric.Tokens).hosts)
        assertEquals(listOf<String?>(null, "offline", "connecting", "indexing"),
            listOf(RemoteUsageHost("a", "online", false), RemoteUsageHost("b", "offline", false), RemoteUsageHost("c", "connecting", false), RemoteUsageHost("d", "online", true)).map { it.gap })
        assertThrows(IllegalArgumentException::class.java) { RemoteUsageHost.parse(JSONObject().put("host", "x").put("status", "asleep").put("indexing", false)) }
    }
    @Test fun aGatewayThatPredatesRemoteHostUsageIsRejectedWithTheRolloutInstruction() {
        // The report an older gateway sends: no per-host usage anywhere.
        val json = JSONObject(javaClass.classLoader!!.getResource("usage.json")!!.readText())
        json.remove("hosts")
        val ranges = json.getJSONArray("ranges")
        for (i in 0 until ranges.length()) for (measure in listOf("cost", "tokens")) ranges.getJSONObject(i).getJSONObject(measure).remove("hosts")
        val failure = assertThrows(IllegalArgumentException::class.java) { UsageReport.parse(json) }
        assertEquals("Update the host: its usage report is outdated", failure.message)
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
        val window = first.getJSONArray("windows").getJSONObject(0)
        window.put("usedPercent", 101)
        assertThrows(IllegalArgumentException::class.java) { UsageReport.parse(json) }
        window.put("usedPercent", 0).put("resetAt", -1)
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
