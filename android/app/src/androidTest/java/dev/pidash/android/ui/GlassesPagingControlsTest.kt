package dev.pidash.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import dev.pidash.g1.GlassesState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Real composables with local state/callbacks; no app service, host mutation or Bluetooth. */
class GlassesPagingControlsTest {
    @get:Rule val compose = createComposeRule()
    private fun ready() = GlassesState(session = "connected", left = "ready", right = "ready", page = 1, pageCount = 3).pendingDisplay()

    @Test fun excerptPagingStaysInSessionDetailAndHonorsBounds() {
        val state = mutableStateOf(ready())
        val selected = mutableStateOf(false)
        val moves = mutableListOf<Int>()
        compose.setContent { MaterialTheme { Column {
            Text("Session detail")
            SessionGlassesControls(state.value, true, selected.value, true, {}, { selected.value = true }, { delta ->
                moves += delta
                state.value = state.value.copy(page = state.value.page + delta).pendingDisplay()
            })
        } } }
        compose.onNodeWithText("Next").assertDoesNotExist()
        compose.onNodeWithText("Reply excerpt on G1").performClick()
        compose.onNodeWithText("Page 1 / 3").assertIsDisplayed()
        compose.onNodeWithText("Previous").assertIsNotEnabled()
        compose.onNodeWithText("Next").assertIsEnabled().performClick()
        compose.onNodeWithText("Page 2 / 3").assertIsDisplayed()
        compose.onNodeWithText("Session detail").assertIsDisplayed()
        compose.onNodeWithText("Reply excerpt on G1").assertIsDisplayed()
        compose.onNodeWithText("Previous").performClick()
        compose.onNodeWithText("Page 1 / 3").assertIsDisplayed()
        compose.onNodeWithText("Next").performClick().performClick()
        compose.onNodeWithText("Page 3 / 3").assertIsDisplayed()
        compose.onNodeWithText("Next").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Display acknowledged").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(1, -1, 1, 1), moves) }
    }

    @Test fun acknowledgmentChangesDoNotShiftControlsAtNarrowWidthAndLargeFont() {
        val state = mutableStateOf(ready())
        compose.setContent { MaterialTheme {
            val density = LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(density, 1.5f)) {
                Column(Modifier.width(260.dp)) {
                    GlassesConnectionControls(state.value, true, true, {}, {}, {})
                    GlassesPagingControls(state.value, true) {}
                    Text("After pager")
                }
            }
        } }
        compose.onNodeWithContentDescription("Awaiting display acknowledgment").assertIsDisplayed()
        compose.onNodeWithContentDescription("Display acknowledged").assertDoesNotExist()
        val after = compose.onNodeWithText("After pager").fetchSemanticsNode().boundsInRoot
        val disconnect = compose.onNodeWithText("Disconnect and release glasses").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle { state.value = state.value.finishDisplay(state.value.displayRevision, true) }
        compose.onNodeWithContentDescription("Display acknowledged").assertIsDisplayed()
        assertEquals(after, compose.onNodeWithText("After pager").fetchSemanticsNode().boundsInRoot)
        assertEquals(disconnect, compose.onNodeWithText("Disconnect and release glasses").fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle { state.value = state.value.copy(page = 2).pendingDisplay() }
        compose.onNodeWithContentDescription("Display acknowledged").assertDoesNotExist()
        compose.onNodeWithContentDescription("Awaiting display acknowledgment").assertIsDisplayed()
        assertEquals(after, compose.onNodeWithText("After pager").fetchSemanticsNode().boundsInRoot)
        assertEquals(disconnect, compose.onNodeWithText("Disconnect and release glasses").fetchSemanticsNode().boundsInRoot)
        compose.onNodeWithText("not confirmed", substring = true).assertDoesNotExist()
        compose.onNodeWithText("on lenses", substring = true).assertDoesNotExist()
    }

    @Test fun failuresAndSuppressionStayVisibleWithoutFalseConfirmation() {
        val initial = ready()
        val state = mutableStateOf(initial.finishDisplay(initial.displayRevision, false))
        compose.setContent { MaterialTheme { GlassesPagingControls(state.value, true) {} } }
        compose.onNodeWithContentDescription("Display not acknowledged").assertIsDisplayed()
        compose.onNodeWithText("Display not acknowledged. Previous text may remain.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Display acknowledged").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(silent = true).pendingDisplay() }
        compose.onNodeWithText("Silent Mode: display suppressed").assertIsDisplayed()
        compose.onNodeWithText("Next").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(silent = false, dismissed = true, page = 0).pendingDisplay() }
        compose.onNodeWithText("Dismissed: select Overview or a session display to show it again").assertIsDisplayed()
        compose.onNodeWithContentDescription("Display acknowledged").assertDoesNotExist()
    }

    @Test fun stoppedMonitoringCannotClaimDisplayConfirmationOrPage() {
        val pending = ready()
        val confirmed = pending.finishDisplay(pending.displayRevision, true)
        compose.setContent { MaterialTheme { GlassesPagingControls(confirmed, false) {} } }
        compose.onNodeWithText("Glasses monitoring stopped").assertIsDisplayed()
        compose.onNodeWithContentDescription("Display acknowledged").assertDoesNotExist()
        compose.onNodeWithText("Next").assertIsNotEnabled()
        compose.onNodeWithText("Previous").assertIsNotEnabled()
    }
}
