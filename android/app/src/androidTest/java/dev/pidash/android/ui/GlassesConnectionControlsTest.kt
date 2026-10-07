package dev.pidash.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.pidash.g1.GlassesState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

/** Exercises the real controls with local callbacks: never starts a service, radio, or host action. */
class GlassesConnectionControlsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun connectNeedsNoChannelEntry() {
        var connects = 0
        compose.setContent { MaterialTheme {
            GlassesConnectionControls(GlassesState(), false, true, { connects++ }, {}, {})
        } }
        compose.onNodeWithText("Connect").assertIsEnabled().performClick()
        compose.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        compose.runOnIdle { assertEquals(1, connects) }
    }

    @Test fun multiplePairsRequireAnExplicitChoice() {
        var choice: String? = null
        val state = GlassesState(session = "Choose your G1 pair", pairs = listOf("38", "45"))
        compose.setContent { MaterialTheme {
            GlassesConnectionControls(state, true, true, {}, {}, { choice = it })
        } }
        compose.runOnIdle { assertNull(choice) }
        compose.onNodeWithText("G1 pair 38").assertIsDisplayed()
        compose.onNodeWithText("G1 pair 45").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("45", choice) }
        compose.onNodeWithText("Connect").assertDoesNotExist()
    }

    @Test fun discoveryProgressIsVisibleAndCanBeCancelled() {
        var disconnects = 0
        val state = GlassesState(session = "Scanning for G1 pairs (20 seconds)…")
        compose.setContent { MaterialTheme {
            GlassesConnectionControls(state, true, true, {}, { disconnects++ }, {})
        } }
        compose.onNodeWithText(state.connectionSummary()).assertIsDisplayed()
        compose.onNodeWithText("G1 pair 38").assertDoesNotExist()
        compose.onNodeWithText("Disconnect and release glasses").performClick()
        compose.runOnIdle { assertEquals(1, disconnects) }
    }

    @Test fun gatewayUpdatesDoNotEraseConnectionErrors() {
        val gateway = mutableStateOf("Host online")
        val error = "No complete G1 pair found. Wear the glasses and tap Connect again."
        val glasses = mutableStateOf(GlassesState(error = error))
        compose.setContent { MaterialTheme { Column {
            Text(gateway.value)
            GlassesConnectionControls(glasses.value, false, true, {
                glasses.value = GlassesState(session = "Starting glasses monitoring…")
            }, {}, {})
        } } }
        compose.onNodeWithText(error).assertIsDisplayed()
        compose.runOnIdle { gateway.value = "Connected · commands run on the host" }
        compose.onNodeWithText("Connected · commands run on the host").assertIsDisplayed()
        compose.onNodeWithText(error).assertIsDisplayed()
        compose.onNodeWithText("Connect").performClick()
        compose.onNodeWithText(error).assertDoesNotExist()
        compose.onNodeWithText(GlassesState(session = "Starting glasses monitoring…").connectionSummary()).assertIsDisplayed()
    }

    @Test fun missingHostPairingIsExplained() {
        compose.setContent { MaterialTheme {
            GlassesConnectionControls(GlassesState(), false, false, {}, {}, {})
        } }
        compose.onNodeWithText("Connect").assertIsNotEnabled()
        compose.onNodeWithText("Pair with your host before connecting glasses.").assertIsDisplayed()
    }
}
