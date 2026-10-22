package dev.pidash.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RoadmapTest {
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResource("roadmap.json")!!.readText())

    @Test fun readsActualSelectedDetailFixtureIncludingNestedPathsNotesAndSeparateProgress() {
        val detail = Detail.parse(fixture())
        val roadmap = detail.roadmap!!
        assertEquals("Ship the viewer 界 🧭", roadmap.title)
        assertEquals("active", roadmap.lifecycle)
        assertEquals(0, roadmap.outcomesComplete)
        assertEquals(2, roadmap.outcomesTotal)
        assertEquals(1, roadmap.complete)
        assertEquals(4, roadmap.total)
        assertEquals(1, roadmap.outcomesBlocked)
        assertEquals(5, roadmap.totalEntries)
        assertFalse(roadmap.limited)
        assertEquals("@1.1", roadmap.entries[1].label)
        assertEquals(2, roadmap.entries[3].depth)
        assertEquals("#1.1.2", roadmap.entries[3].label)
        assertEquals("blocked", roadmap.entries[3].status)
        assertEquals(listOf("Waiting for dependency"), roadmap.entries[3].notes)
    }

    @Test fun explicitStatusesAndLimitsAreNotInterpretedAsVerification() {
        val j = fixture().getJSONObject("roadmap")
        j.put("totalEntries", 1000)
        j.getJSONArray("entries").getJSONObject(0).put("status", "verified-unsubstantiated")
        val roadmap = Roadmap.parse(j)
        assertTrue(roadmap.limited)
        assertEquals("verified-unsubstantiated", roadmap.entries.first().status)
        j.put("entries", org.json.JSONArray()).put("totalEntries", 0)
        assertTrue(Roadmap.parse(j).entries.isEmpty())
        assertFalse(Roadmap.parse(j).limited)
        val noPlan = fixture().put("roadmap", JSONObject.NULL)
        assertNull(Detail.parse(noPlan).roadmap)
    }

    @Test fun selectedDetailReplacesRoadmapOnUpdatesAndClear() {
        val session = Session.parse(fixture())
        val state = Dashboard(selected = session.id, connected = true, epoch = "e", seq = 1)
        val frame = JSONObject().put("version", 1).put("epoch", "e").put("seq", 2).put("at", 1)
            .put("type", "detail").put("id", session.id).put("detail", fixture())
        val first = reduceFrame(state, frame, 1)
        assertNotNull(first.detail!!.roadmap)
        val cleared = reduceFrame(first, frame.put("seq", 3).put("detail", fixture().put("roadmap", JSONObject.NULL)), 2)
        assertNull(cleared.detail!!.roadmap)
    }

    @Test fun validDeepPathsAreAcceptedWithoutLosingTheirIdentity() {
        val json = fixture().getJSONObject("roadmap")
        val path = List(91) { "1" }.joinToString(".")
        json.getJSONArray("entries").getJSONObject(0).put("path", path)
        assertEquals(path, Roadmap.parse(json).entries.first().path)
    }

    @Test fun sameEpochReconnectDoesNotPromoteOldRoadmapDetailToLive() {
        val detail = Detail.parse(fixture())
        val disconnected = Dashboard(sessions = listOf(detail.session), selected = detail.session.id, detail = detail,
            epoch = "same-gateway", seq = 8, connected = false, fresh = false)
        val frame = JSONObject().put("version", 1).put("epoch", "same-gateway").put("seq", 1).put("at", 10)
            .put("type", "snapshot").put("sessions", org.json.JSONArray().put(fixture()))
        val reconnected = reduceFrame(disconnected, frame, 10)
        assertTrue(reconnected.fresh)
        assertEquals(detail.session.id, reconnected.selected)
        assertNull("An overview is not fresh selected detail", reconnected.detail)
        val refreshed = reduceFrame(reconnected, JSONObject().put("version", 1).put("epoch", "same-gateway")
            .put("seq", 2).put("at", 11).put("type", "detail").put("id", detail.session.id).put("detail", fixture()), 11)
        assertNotNull(refreshed.detail!!.roadmap)
    }

    @Test fun disconnectOverviewUpdatesRetainedDetailMetadataWithoutDroppingTheRoadmap() {
        val detail = Detail.parse(fixture())
        val state = Dashboard(sessions = listOf(detail.session), selected = detail.session.id, detail = detail,
            epoch = "gateway", seq = 1, connected = true, fresh = true)
        val summary = fixture().put("connected", false)
        summary.getJSONObject("status").put("kind", "exited").put("label", "exited")
        val frame = JSONObject().put("version", 1).put("epoch", "gateway").put("seq", 2).put("at", 10)
            .put("type", "snapshot").put("sessions", org.json.JSONArray().put(summary))
        val updated = reduceFrame(state, frame, 10)
        assertFalse(updated.detail!!.session.connected)
        assertEquals("exited", updated.detail!!.session.status)
        assertSame(detail.roadmap, updated.detail!!.roadmap)
    }

    @Test fun rejectsInvalidPathsKindsAndEntryCounts() {
        val j = fixture().getJSONObject("roadmap")
        val entry = j.getJSONArray("entries").getJSONObject(0)
        entry.put("kind", "command")
        assertThrows(IllegalArgumentException::class.java) { Roadmap.parse(j) }
        entry.put("kind", "item").put("path", "not.a.path")
        assertThrows(IllegalArgumentException::class.java) { Roadmap.parse(j) }
        entry.put("path", "1")
        j.put("totalEntries", 0)
        assertThrows(IllegalArgumentException::class.java) { Roadmap.parse(j) }
    }
}
