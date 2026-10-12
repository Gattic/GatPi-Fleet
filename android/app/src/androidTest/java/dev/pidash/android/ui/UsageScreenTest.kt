package dev.pidash.android.ui

import android.os.SystemClock
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.ViewModelProvider
import dev.pidash.android.DashViewModel
import dev.pidash.android.MainActivity
import dev.pidash.android.QuotaAccount
import dev.pidash.android.QuotaWindow
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

    @Test fun recreationDoesNotRenewFreshnessOrRewindResetCountdowns() {
        // Deliberately unlike the phone's wall clock: time must remain relative to the host.
        val at = 1_000_000_000_000L
        val measure = UsageMeasure(emptyList(), emptyList(), emptyList())
        val report = UsageReport(at, false,
            listOf(QuotaAccount("Codex", "fresh", at, at + 5_000, null,
                listOf(QuotaWindow("Weekly", 56.0, at + 5_000)))),
            emptyList(), UsageReport.RANGES.map { UsageRange(it, 1, 0.0, 0.0, 0.0, measure, measure) })
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
}
