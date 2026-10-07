package dev.pidash.g1

import org.junit.Assert.*
import org.junit.Test

class GlassesStateTest {
    private fun ready() = GlassesState(session = "connected", left = "ready", right = "ready", page = 1, pageCount = 3)

    @Test fun aNewPageIsPendingUntilItsOwnAcknowledgmentsArrive() {
        val first = ready().pendingDisplay()
        val confirmed = first.finishDisplay(first.displayRevision, true)
        assertEquals(DisplayStatus.ACKNOWLEDGED, confirmed.displayStatus)
        val next = confirmed.copy(page = 2).pendingDisplay()
        assertEquals(DisplayStatus.PENDING, next.displayStatus)
        assertEquals(next, next.finishDisplay(first.displayRevision, true))
        assertEquals(DisplayStatus.ACKNOWLEDGED, next.finishDisplay(next.displayRevision, true).displayStatus)
    }

    @Test fun newContentOnTheSamePageInvalidatesOldAcknowledgments() {
        val first = ready().pendingDisplay()
        val refreshed = first.pendingDisplay()
        assertEquals(first.page, refreshed.page)
        assertEquals(refreshed, refreshed.finishDisplay(first.displayRevision, true))
    }

    @Test fun failedDeliveryIsNotConfirmationAndNextRequestClearsFailure() {
        val pending = ready().pendingDisplay()
        val failed = pending.finishDisplay(pending.displayRevision, false)
        assertEquals(DisplayStatus.FAILED, failed.displayStatus)
        assertEquals(DisplayStatus.PENDING, failed.pendingDisplay().displayStatus)
    }

    @Test fun bothArmsMustBeReadyToConfirm() {
        val pending = ready().copy(right = "connecting").pendingDisplay()
        assertEquals(pending, pending.finishDisplay(pending.displayRevision, true))
    }

    @Test fun dismissalAndSilentModeInvalidateInFlightCompletion() {
        val pending = ready().pendingDisplay()
        val dismissed = pending.copy(page = 0, dismissed = true).pendingDisplay()
        val silent = pending.copy(silent = true).pendingDisplay()
        for (suppressed in listOf(dismissed, silent)) {
            assertEquals(DisplayStatus.IDLE, suppressed.displayStatus)
            assertEquals(suppressed, suppressed.finishDisplay(pending.displayRevision, true))
            assertEquals(suppressed, suppressed.finishDisplay(suppressed.displayRevision, true))
        }
        val resumed = silent.copy(silent = false).pendingDisplay()
        assertEquals(DisplayStatus.PENDING, resumed.displayStatus)
        assertEquals(resumed, resumed.finishDisplay(pending.displayRevision, true))
    }

    @Test fun linkLossInvalidatesConfirmationAndEarlierCompletion() {
        val pending = ready().pendingDisplay()
        val confirmed = pending.finishDisplay(pending.displayRevision, true)
        val lost = confirmed.copy(left = "disconnected").pendingDisplay()
        assertEquals(DisplayStatus.PENDING, lost.displayStatus)
        val recovered = lost.copy(left = "ready")
        assertEquals(recovered, recovered.finishDisplay(pending.displayRevision, true))
        assertEquals(DisplayStatus.ACKNOWLEDGED, recovered.finishDisplay(recovered.displayRevision, true).displayStatus)
    }

    @Test fun normalPageUpdatesDoNotAlterConnectionText() {
        val pending = ready().pendingDisplay()
        val confirmed = pending.finishDisplay(pending.displayRevision, true)
        val next = confirmed.copy(page = 2).pendingDisplay()
        assertEquals("connected · L ready · R ready", pending.connectionSummary())
        assertEquals(pending.connectionSummary(), confirmed.connectionSummary())
        assertEquals(pending.connectionSummary(), next.connectionSummary())
    }
}
