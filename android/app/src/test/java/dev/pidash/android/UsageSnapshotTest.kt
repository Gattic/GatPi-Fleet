package dev.pidash.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageSnapshotTest {
    @Test fun timeSpentWithoutAScreenStillCountsTowardFreshnessAndReset() {
        val at = 1_000_000_000_000L
        val account = QuotaAccount("Codex", "fresh", at, at + 120_000, null,
            listOf(QuotaWindow("Weekly", 56.0, at + 180_000)))
        val snapshot = UsageSnapshot(UsageReport(at, false, listOf(account), emptyList(), emptyList(), emptyList()), receivedAt = 5_000)

        // Nothing needs to observe the report for its clock to advance, including across sleep.
        assertTrue(account.fresh(snapshot.hostTime(124_999)))
        assertFalse(account.fresh(snapshot.hostTime(125_000)))
        val resumedAt = snapshot.hostTime(185_000)
        assertEquals(at + 180_000, resumedAt)
        assertFalse(account.fresh(resumedAt))
        assertEquals(0L, account.windows.single().resetAt!! - resumedAt)
    }
}
