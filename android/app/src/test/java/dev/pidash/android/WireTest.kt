package dev.pidash.android

import dev.pidash.g1.TextPager
import org.json.JSONArray
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
    @Test fun readsBackgroundJobsAndToleratesAHostThatDoesNotReportThem() {
        val json = fixture()
        val session = json.getJSONArray("sessions").getJSONObject(0)
        val resources = JSONObject().put("cpu", 0.5).put("memory", 1e8).put("gpuMemory", JSONObject.NULL)
            .put("background", JSONArray()
                .put(JSONObject().put("kind", "job").put("label", "nightly-build").put("detail", "npm run test")
                    .put("startedAt", 10L).put("cpu", 0.3).put("memory", 1e8))
                .put(JSONObject().put("kind", "subagent").put("label", "coder").put("detail", JSONObject.NULL)
                    .put("startedAt", 20L).put("cpu", 0.1).put("memory", 5e7)))
        session.put("resources", resources)
        val metrics = reduceFrame(Dashboard(), json, 10).sessions.single().metrics!!
        assertEquals(listOf("job", "subagent"), metrics.background.map { it.kind })
        assertEquals("npm run test", metrics.background[0].detail)
        assertNull(metrics.background[1].detail)
        assertEquals(10L, metrics.background[0].startedAt)
        assertEquals(0.3, metrics.background[0].cpu, 0.0)
        // A host that predates the field is not treated as an error.
        resources.remove("background")
        assertEquals(emptyList<Background>(), reduceFrame(Dashboard(), json, 10).sessions.single().metrics!!.background)
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
    @Test fun readsTheActualHostContextFixtureWithMeasuredTotalsAndEstimatedParts() {
        val report = ContextReport.parse(JSONObject(javaClass.classLoader!!.getResource("context.json")!!.readText()))
        assertEquals(listOf("open", "today", "30d"), report.scopes.map { it.scope })
        val open = report.scope("open")
        assertEquals(listOf("pi-dash", "legacy", "Site redesign"), open.rows.map { it.label })
        assertEquals(166_000.0, open.rows[0].tokens!!, 0.0)
        assertEquals(200_000.0, open.rows[0].window!!, 0.0)
        assertEquals(83.0, open.rows[0].percent!!, 0.0)
        assertEquals(18_000.0, open.rows[0].breakdown!!.unattributed!!, 0.0)
        assertEquals("measured", open.rows[0].breakdown!!.totalBasis)
        assertNull("an older bridge keeps its measured total without a composition", open.rows[1].breakdown)
        assertNull("an unknown total stays unknown, not zero", open.rows[2].tokens)
        assertEquals("estimate", open.rows[2].breakdown!!.totalBasis)
        assertNull(open.rows[2].breakdown!!.unattributed)
        assertEquals(206_000.0, open.cumulative.fillTokens, 0.0)
        assertEquals(400_000.0, open.cumulative.fillWindows, 0.0)
        assertEquals(listOf(1, 1, 0), listOf(open.cumulative.near, open.cumulative.unknown, open.cumulative.unbridged))
        assertEquals(166_000.0, open.cumulative.compositionTokens, 0.0)
        assertEquals(listOf(ContextHost(null, 206_000.0)), open.cumulative.hosts)
        assertEquals(0, open.cumulative.endedSessions)
        val today = report.scope("today")
        assertEquals("site \u203a Fix the header", today.rows[1].label)
        assertNull("an ended session's window is unknown until the catalog supplies it", today.rows[1].window)
        assertEquals(90_000.0, today.cumulative.endedTokens, 0.0)
        assertEquals(1, today.cumulative.endedSessions)
        assertEquals(listOf(ContextModel("claude-opus-5-5", 90_000.0, 1)), today.cumulative.models)
        assertEquals(5, report.scope("30d").rows.size)
    }
    @Test fun aContextReportWithoutAllThreeScopesIsRejected() {
        val json = JSONObject(javaClass.classLoader!!.getResource("context.json")!!.readText())
        json.put("scopes", JSONArray())
        assertThrows(IllegalArgumentException::class.java) { ContextReport.parse(json) }
        json.put("scopes", JSONObject(javaClass.classLoader!!.getResource("context.json")!!.readText()).getJSONArray("scopes").let { a ->
            JSONArray().put(a.getJSONObject(0)).put(a.getJSONObject(1)).put(a.getJSONObject(1).put("scope", "7d"))
        })
        assertThrows(IllegalArgumentException::class.java) { ContextReport.parse(json) }
    }
    @Test fun detailCarriesTheSessionContextBreakdownWhenTheBridgeReportsIt() {
        val session = fixture().getJSONArray("sessions").getJSONObject(0)
        session.put("prompts", JSONArray()).put("models", JSONArray()).put("asks", JSONArray()).put("tools", JSONArray())
        session.put("context", JSONObject().put("tokens", 1000.0).put("window", 200_000.0).put("percent", 0.5).put("breakdown",
            JSONObject().put("parts", JSONObject().put("system", 100.0).put("tools", 200.0).put("injected", 0.0).put("user", 50.0)
                .put("assistant", 100.0).put("toolResults", 50.0).put("summary", 0.0))
                .put("unattributed", 500.0).put("totalBasis", "measured").put("imageTokens", 0.0)
                .put("counts", JSONObject().put("user", 1).put("assistant", 1).put("toolResults", 1).put("injected", 0).put("imageBlocks", 0))
                .put("compactAt", 183_616.0)))
        val context = Detail.parse(session).context!!
        assertEquals(1000.0, context.tokens!!, 0.0)
        assertEquals(200.0, context.breakdown!!.parts.tools, 0.0)
        assertEquals(500.0, context.breakdown!!.unattributed!!, 0.0)
        assertEquals("measured", context.breakdown!!.totalBasis)
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
    @Test fun aReconnectKeepsTheSelectedSessionsDetailAndUpdatesItsMetadata() {
        val state = reduceFrame(Dashboard(), fixture(), 1)
        val session = state.sessions.single()
        val detail = Detail(session, "prompt", emptyList(), "reply", null, null, emptyList(), emptyList(), emptyList())
        val selected = state.copy(selected = session.id, detail = detail)
        val renamed = fixture().let { json ->
            json.getJSONArray("sessions").getJSONObject(0).put("label", "renamed")
            json
        }
        val resumed = reduceFrame(selected.copy(connected = false), renamed, 2)
        assertEquals(session.id, resumed.selected)
        assertEquals("renamed", resumed.detail!!.session.label)
        assertEquals("reply", resumed.detail!!.reply)
        assertTrue(resumed.detailStale)
    }
    @Test fun aRefreshThatLosesTheSelectedSessionClearsItAndItsDetail() {
        val state = reduceFrame(Dashboard(), fixture(), 1)
        val session = state.sessions.single()
        val selected = state.copy(selected = session.id,
            detail = Detail(session, "prompt", emptyList(), "reply", null, null, emptyList(), emptyList(), emptyList()))
        val resumed = reduceFrame(selected.copy(connected = false), fixture().put("sessions", org.json.JSONArray()), 2)
        assertNull(resumed.selected)
        assertNull(resumed.detail)
        assertFalse(resumed.detailStale)
        assertTrue(sessionPageLostSelection(Screen.Session, resumed))
    }
    @Test fun onlyTheSessionPageReturnsHomeWhenItsSessionIsGone() {
        assertTrue(sessionPageLostSelection(Screen.Session, Dashboard(connected = true)))
        assertFalse(sessionPageLostSelection(Screen.Session, Dashboard(connected = true, selected = "s")))
        assertFalse(sessionPageLostSelection(Screen.Session, Dashboard(connected = false)))
        assertFalse(sessionPageLostSelection(Screen.Sessions, Dashboard(connected = true)))
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
