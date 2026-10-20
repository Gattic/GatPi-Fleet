package dev.pidash.android.ui

import android.os.SystemClock
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.ViewModelProvider
import dev.pidash.android.DashViewModel
import dev.pidash.android.HostUsage
import dev.pidash.android.MainActivity
import dev.pidash.android.QuotaAccount
import dev.pidash.android.QuotaWindow
import dev.pidash.android.RemoteUsageHost
import dev.pidash.android.Screen
import dev.pidash.android.UsageMeasure
import dev.pidash.android.UsageRange
import dev.pidash.android.UsageReport
import dev.pidash.android.UsageSnapshot
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test

/** No gateway requests: seed the real retained ViewModel and recreate the real Activity. */
class UsageScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun idleAnthropicFiveHourBalanceIsShownAlongsideWeeklyLimits() {
        val at = 1_000_000_000_000L
        val measure = UsageMeasure(emptyList(), emptyList(), emptyList(), emptyList())
        val report = UsageReport(at, false, listOf(
            QuotaAccount("anthropic", "fresh", at, at + 120_000, null,
                listOf(QuotaWindow("5h", 0.0, null), QuotaWindow("7d", 100.0, at + 86_400_000))),
            QuotaAccount("codex", "fresh", at, at + 120_000, null,
                listOf(QuotaWindow("7d", 56.0, at + 86_400_000))),
        ), emptyList(), emptyList(), UsageReport.RANGES.map { UsageRange(it, 1, 0.0, 0.0, 0.0, measure, measure) })
        compose.runOnUiThread {
            val vm = ViewModelProvider(compose.activity)[DashViewModel::class.java]
            vm.usage.value = UsageSnapshot(report, SystemClock.elapsedRealtime())
            vm.screen.value = Screen.Usage
        }
        compose.onNodeWithText("5h: 100% left").assertIsDisplayed()
        compose.onNodeWithText("Reset time not reported").assertIsDisplayed()
        compose.onNodeWithText("7d: 0% left").assertIsDisplayed()
        compose.onNodeWithText("7d: 44% left").assertIsDisplayed()
        compose.onNodeWithText("Stale — refresh to update").assertDoesNotExist()
        compose.onNodeWithText("Reset due — refresh to update").assertDoesNotExist()
    }

    @Test fun recreationDoesNotRenewFreshnessOrRewindResetCountdowns() {
        // Deliberately unlike the phone's wall clock: time must remain relative to the host.
        val at = 1_000_000_000_000L
        val measure = UsageMeasure(emptyList(), emptyList(), emptyList(), emptyList())
        val report = UsageReport(at, false,
            listOf(QuotaAccount("Codex", "fresh", at, at + 5_000, null,
                listOf(QuotaWindow("Weekly", 56.0, at + 5_000)))),
            emptyList(), emptyList(), UsageReport.RANGES.map { UsageRange(it, 1, 0.0, 0.0, 0.0, measure, measure) })
        lateinit var vm: DashViewModel
        compose.runOnUiThread {
            vm = ViewModelProvider(compose.activity)[DashViewModel::class.java]
            vm.usage.value = UsageSnapshot(report, SystemClock.elapsedRealtime())
            vm.screen.value = Screen.Usage
        }
        compose.onNodeWithText("Weekly: 44% left").assertIsDisplayed()
        compose.onNodeWithText("Stale — refresh to update").assertDoesNotExist()
        compose.waitUntil(timeoutMillis = 15_000) {
            compose.onAllNodesWithText("Reset due — refresh to update").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Stale — refresh to update").assertIsDisplayed()

        compose.activityRule.scenario.recreate()

        compose.runOnUiThread {
            assertSame(vm, ViewModelProvider(compose.activity)[DashViewModel::class.java])
            assertSame(report, vm.usage.value?.report)
        }
        compose.onNodeWithText("Stale — refresh to update").assertIsDisplayed()
        compose.onNodeWithText("Reset due — refresh to update").assertIsDisplayed()
        compose.onNodeWithText("Weekly: 44% left").assertIsDisplayed()
    }

    @Test fun remoteHostsGetTheirOwnCardAndTheIncompleteOnesAreMarkedWithTheirFigures() {
        val at = 1_000_000_000_000L
        val measure = UsageMeasure(emptyList(), emptyList(), emptyList(),
            listOf(HostUsage(null, 1.0), HostUsage("box00", 3.0), HostUsage("boxhome", 0.0)))
        val report = UsageReport(at, false, emptyList(), emptyList(),
            listOf(RemoteUsageHost("box00", "online", false), RemoteUsageHost("boxhome", "offline", false)),
            UsageReport.RANGES.map { UsageRange(it, 1, 4.0, 4e6, 0.0, measure, measure) })
        compose.runOnUiThread {
            val vm = ViewModelProvider(compose.activity)[DashViewModel::class.java]
            vm.usage.value = UsageSnapshot(report, SystemClock.elapsedRealtime())
            vm.screen.value = Screen.Usage
        }
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("COST BY HOST"))
        compose.onNodeWithText("COST BY HOST").assertIsDisplayed()
        compose.onNodeWithText("Gateway host").assertIsDisplayed()
        compose.onNodeWithText("25% · $1.00").assertIsDisplayed()
        compose.onNodeWithText("box00").assertIsDisplayed()
        compose.onNodeWithText("75% · $3.00").assertIsDisplayed()
        compose.onNodeWithText("boxhome").assertIsDisplayed()
        compose.onNodeWithText("offline").assertIsDisplayed()
        compose.onNodeWithText("0% · $0.00").assertIsDisplayed()
        compose.onNodeWithText("A host that is offline, connecting or still indexing shows what it has reported so far; its totals are incomplete.").assertIsDisplayed()
    }
}
