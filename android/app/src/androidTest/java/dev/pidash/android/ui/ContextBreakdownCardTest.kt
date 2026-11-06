package dev.pidash.android.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.pidash.android.ContextBreakdown
import dev.pidash.android.ContextCounts
import dev.pidash.android.ContextParts
import dev.pidash.android.SessionContext
import org.junit.Rule
import org.junit.Test

/** The card session detail shows for one session's measured total and estimated composition. */
class ContextBreakdownCardTest {
    @get:Rule val compose = createComposeRule()

    @Test fun measuredTotalEstimatedPartsAndUnattributedAreLabelled() {
        val breakdown = ContextBreakdown(ContextParts(12_000.0, 14_000.0, 30_000.0, 6_000.0, 16_000.0, 68_000.0, 2_000.0),
            18_000.0, "measured", 0.0, ContextCounts(2, 3, 4, 1, 0), 183_616.0)
        compose.setContent { PiDashTheme { ContextBreakdownCard(SessionContext(166_000.0, 200_000.0, 83.0, breakdown)) } }
        compose.onNodeWithText("CONTEXT BREAKDOWN").assertIsDisplayed()
        compose.onNodeWithText("Measured").assertIsDisplayed()
        compose.onNodeWithText("166k").assertIsDisplayed()
        compose.onNodeWithText("83%").assertIsDisplayed()
        compose.onNodeWithText("unattributed").assertIsDisplayed()
        compose.onNodeWithText("+18.0k (11%)").assertIsDisplayed()
        compose.onNodeWithText("Total is measured; parts are estimated from characters/4. Compact at 184k. No prompt or transcript text is sent to this device.").assertIsDisplayed()
    }

    @Test fun anUnknownTotalIsNotShownAsZeroAndAnAbsentBreakdownIsNamed() {
        compose.setContent { PiDashTheme { ContextBreakdownCard(SessionContext(null, 200_000.0, null, null)) } }
        compose.onNodeWithText("Unknown — the host has not measured this session's context.").assertIsDisplayed()
        compose.onNodeWithText("No composition estimate from this host's bridge.").assertIsDisplayed()
        compose.onNodeWithText("0").assertDoesNotExist()
    }
}
