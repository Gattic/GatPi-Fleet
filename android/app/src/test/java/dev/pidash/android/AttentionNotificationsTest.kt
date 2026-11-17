package dev.pidash.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttentionNotificationsTest {
    private fun session(id: String, attention: String? = null) = Session(
        id = id, revision = "rev-$id", label = "label-$id", project = "/project",
        status = if (attention == null) "working" else "needs-you",
        statusLabel = if (attention == null) "bash" else "needs you",
        since = 1L, attentionKey = attention, connected = true,
        model = null, thinking = null, contextPercent = null, plan = null, metrics = null,
        tokens = null, cost = null, commands = emptyMap(),
    )
    private fun dashboard(vararg sessions: Session, fresh: Boolean = true) = Dashboard(sessions = sessions.toList(), fresh = fresh)

    @Test fun aFirstSnapshotSeedsWithoutReplayingTheBacklog() {
        val notifier = AttentionNotifier()
        val needy = session("a", "a:needs-you:1")
        assertEquals(emptyList<Session>(), notifier.update(dashboard(needy)).alerts)
        assertEquals(emptyList<Session>(), notifier.update(dashboard(needy)).alerts)
        assertEquals(emptyList<String>(), notifier.update(dashboard(needy)).cleared)
    }
    @Test fun aNewAttentionKeyAlertsOnceAndAChangedKeyAlertsAgain() {
        val notifier = AttentionNotifier()
        notifier.update(dashboard(session("a")))
        val needy = session("a", "a:needs-you:5")
        val alert = notifier.update(dashboard(needy))
        assertEquals(listOf("label-a"), alert.alerts.map { it.label })
        assertEquals(emptyList<String>(), alert.cleared)
        assertEquals(emptyList<Session>(), notifier.update(dashboard(needy)).alerts)
        val failed = session("a", "a:error:9")
        assertEquals(listOf("a:error:9"), notifier.update(dashboard(failed)).alerts.map { it.attentionKey })
        assertEquals(emptyList<String>(), notifier.update(dashboard(failed)).cleared)
    }
    @Test fun attentionThatStopsClearsItsNotification() {
        val notifier = AttentionNotifier()
        notifier.update(dashboard(session("a")))
        notifier.update(dashboard(session("a", "a:needs-you:1"), session("b", "b:needs-you:2")))
        assertEquals(listOf("a"), notifier.update(dashboard(session("a"), session("b", "b:needs-you:2"))).cleared)
        assertEquals(emptyList<String>(), notifier.update(dashboard(session("a"), session("b", "b:needs-you:2"))).cleared)
    }
    @Test fun aReconnectSeedsWithoutReplayAndStillClears() {
        val notifier = AttentionNotifier()
        notifier.update(dashboard(session("a")))
        notifier.update(dashboard(session("a", "a:needs-you:1")))
        // A lost connection is not evidence that the session stopped needing you.
        assertEquals(AttentionUpdate(emptyList(), emptyList()), notifier.update(dashboard(session("a", "a:needs-you:1"), fresh = false)))
        val reconnected = notifier.update(dashboard(session("a")))
        assertEquals(emptyList<Session>(), reconnected.alerts)
        assertEquals(listOf("a"), reconnected.cleared)
        // Only a transition after the new baseline alerts.
        assertEquals(listOf("a:needs-you:7"), notifier.update(dashboard(session("a", "a:needs-you:7"))).alerts.map { it.attentionKey })
    }
    @Test fun resetReturnsWhatIsOnScreenAndForgetsTheBaseline() {
        val notifier = AttentionNotifier()
        notifier.update(dashboard(session("a")))
        notifier.update(dashboard(session("a", "a:needs-you:1")))
        assertEquals(listOf("a"), notifier.reset())
        assertEquals(emptyList<String>(), notifier.reset())
        // After reset the next snapshot is a seed again, so switching alerts off and on does not replay.
        assertEquals(emptyList<Session>(), notifier.update(dashboard(session("a", "a:needs-you:1"))).alerts)
    }
    @Test fun attentionIdsAreStableAndSeparateFromTheServiceNotification() {
        assertEquals(Channels.attentionId("session"), Channels.attentionId("session"))
        assertTrue(Channels.attentionId("session") >= 2)
        assertNotEquals(Channels.FOREGROUND_ID, Channels.attentionId("session"))
    }
}
