package dev.pidash.android

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsDisplayed
import org.junit.Rule
import org.junit.Test

/** Navigation only: safe on an existing pairing. Never sends a command or starts Bluetooth. */
class DashboardSmokeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @Test fun dashboardAndOptionalGlassesOnboardingAreReachable() {
        compose.onNodeWithText("pi-dash").assertIsDisplayed()
        compose.onNodeWithText("Glasses").performClick()
        compose.onNodeWithText("Even Realities G1").assertIsDisplayed()
        compose.onNodeWithText("Connect").assertIsDisplayed()
        compose.onNodeWithText("G1 channel").assertDoesNotExist()
        compose.onNodeWithText("Pairing").performClick()
        compose.onNodeWithText("Secure local pairing").assertIsDisplayed()
        compose.onNodeWithText("Sessions").performClick()
        compose.onNodeWithText("Find session / project").assertIsDisplayed()
    }
}
