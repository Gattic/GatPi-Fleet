package dev.pidash.android.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.ViewModelProvider
import dev.pidash.android.ContextBreakdown
import dev.pidash.android.ContextCounts
import dev.pidash.android.ContextHost
import dev.pidash.android.ContextModel
import dev.pidash.android.ContextParts
import dev.pidash.android.ContextReport
import dev.pidash.android.ContextRow
import dev.pidash.android.ContextScopeReport
import dev.pidash.android.CumulativeContext
import dev.pidash.android.DashViewModel
import dev.pidash.android.MainActivity
import dev.pidash.android.Screen
import org.junit.Rule
import org.junit.Test

/** No gateway requests: seed the real retained ViewModel and recreate the real Activity. */
class ContextScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val at = 1_000_000_000_000L
    private val parts = ContextParts(12_000.0, 14_000.0, 30_000.0, 6_000.0, 16_000.0, 68_000.0, 2_000.0)
    private val measured = ContextBreakdown(parts, 18_000.0, "measured", 0.0, ContextCounts(2, 3, 4, 1, 0), 183_616.0)
    private val estimate = ContextBreakdown(ContextParts(2_000.0, 3_000.0, 0.0, 1_000.0, 2_000.0, 2_000.0, 0.0), null, "estimate", 0.0,
        ContextCounts(1, 1, 1, 0, 0), 183_616.0)

    private fun row(label: String, tokens: Double?, window: Double?, percent: Double?, breakdown: ContextBreakdown?, live: Boolean = true, model: String? = null) =
        ContextRow("id-$label", label, null, model, tokens, window, percent, breakdown?.compactAt, live, false, at, breakdown)

    private fun cumulative(unknown: Int, endedTokens: Double, endedSessions: Int, models: List<ContextModel>) = CumulativeContext(
        parts, 166_000.0, 18_000.0, 0.0, 0, 206_000.0, 400_000.0, 1, unknown, 0, endedTokens, endedSessions,
        listOf(ContextHost(null, 206_000.0)), models)

    private val report = ContextReport(at, listOf(
        ContextScopeReport("open", listOf(
            row("pi-dash", 166_000.0, 200_000.0, 83.0, measured),
            row("legacy", 40_000.0, 200_000.0, 20.0, null),
            row("Site redesign", null, 200_000.0, null, estimate),
        ), cumulative(1, 0.0, 0, emptyList())),
        ContextScopeReport("today", listOf(
            row("pi-dash", 166_000.0, 200_000.0, 83.0, measured),
            row("site \u203a Fix the header", 90_000.0, null, null, null, live = false, model = "claude-opus-5-5"),
            row("legacy", 40_000.0, 200_000.0, 20.0, null),
            row("Site redesign", null, 200_000.0, null, estimate),
        ), cumulative(1, 90_000.0, 1, listOf(ContextModel("claude-opus-5-5", 90_000.0, 1)))),
        ContextScopeReport("30d", listOf(
            row("pi-dash", 166_000.0, 200_000.0, 83.0, measured),
            row("site \u203a Fix the header", 90_000.0, null, null, null, live = false, model = "claude-opus-5-5"),
            row("legacy", 40_000.0, 200_000.0, 20.0, null),
            row("Site redesign", null, 200_000.0, null, estimate),
        ), cumulative(1, 90_000.0, 1, listOf(ContextModel("claude-opus-5-5", 90_000.0, 1)))),
    ))

    @Test fun cumulativeCompositionAndRowsShowMeasuredTotalsAndUnknowns() {
        compose.runOnUiThread {
            val vm = ViewModelProvider(compose.activity)[DashViewModel::class.java]
            vm.context.value = report
            vm.screen.value = Screen.Context
        }
        compose.onNodeWithText("CUMULATIVE COMPOSITION").assertIsDisplayed()
        compose.onAllNodesWithText("166k").onFirst().assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("1 ≥ 80% · 1 unknown · 0 unbridged"))
        compose.onNodeWithText("1 ≥ 80% · 1 unknown · 0 unbridged").assertExists()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("BY SESSION (3)"))
        compose.onNodeWithText("BY SESSION (3)").assertIsDisplayed()
        compose.onNodeWithText("Site redesign").assertIsDisplayed()
        compose.onNodeWithText("unknown · compact at 184k").assertExists()
        compose.onNodeWithText("legacy").assertExists()
        compose.onNodeWithText("no breakdown").assertExists()
    }

    @Test fun switchingToTodayAddsEndedSessionsAndTheirTotals() {
        compose.runOnUiThread {
            val vm = ViewModelProvider(compose.activity)[DashViewModel::class.java]
            vm.context.value = report
            vm.screen.value = Screen.Context
        }
        compose.onNodeWithText("Today").performClick()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("Ended (fill only) 90.0k over 1 sessions."))
        compose.onNodeWithText("Ended (fill only) 90.0k over 1 sessions.").assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText("BY SESSION (4)"))
        compose.onNodeWithText("BY SESSION (4)").assertIsDisplayed()
        compose.onNodeWithText("site \u203a Fix the header").assertIsDisplayed()
        compose.onNodeWithText("no breakdown · ended").assertExists()
    }
}
