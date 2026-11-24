package dev.pidash.android.ui

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.Dashboard
import dev.pidash.android.DraftStorage
import dev.pidash.android.Drafts
import dev.pidash.android.Screen
import dev.pidash.android.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Long press on a session opens its management menu; the menu acts on that session, not the previous selection. */
class SessionMenuTest {
    @get:Rule val compose = createComposeRule()

    private fun vm(): DashViewModel {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val drafts = Drafts(object : DraftStorage {
            override fun read(): String? = null
            override fun save(document: String) = Unit
        }) { null }
        return DashViewModel(app, drafts).also { it.back() }
    }

    private fun session(commands: Map<String, String?>) =
        Session("s", "r", "project", "/work/project", "ready", "ready", null, null, true, null, null, null, null, null, null, null, commands)

    @Test fun longPressListsRunControlAndConfirmsThePressedSession() {
        val vm = vm()
        val ready = session(mapOf(
            "prompt" to null, "abort" to null, "compact" to null, "reload" to null,
            "new" to null, "restart" to null, "shutdown" to null, "dismiss" to "Only exited sessions can be dismissed",
        ))
        val enabled = mutableStateOf(true)
        compose.setContent { MaterialTheme { SessionsScreen(vm, Dashboard(sessions = listOf(ready), updatedAt = 1L), enabled.value) } }
        // A different session was selected before; the menu must act on the one that was pressed.
        compose.runOnIdle { vm.repository.select("previous") }

        compose.onNodeWithText("project").performTouchInput { longClick() }
        for (label in listOf("Abort", "Compact", "Reload", "New session", "Restart", "Close gracefully")) compose.onNodeWithText(label).assertIsDisplayed()
        // The host blocks dismiss until the session exits, so it is not offered.
        compose.onNodeWithText("Dismiss").assertDoesNotExist()

        compose.onNodeWithText("Restart").performClick()
        compose.runOnIdle {
            val confirmation = vm.confirmation.value!!
            assertEquals(ready, confirmation.target)
            assertEquals("restart", confirmation.command!!.getString("kind"))
            assertEquals(Screen.Sessions, vm.screen.value)
            assertEquals("previous", vm.repository.state.value.selected)
            vm.confirmed()
        }
        compose.runOnIdle {
            assertEquals(ready.id, vm.repository.state.value.selected)
            assertEquals(Screen.Sessions, vm.screen.value)
            // The unpaired test gateway rejects the command before anything is sent.
            assertTrue(vm.repository.state.value.message.contains("Fresh gateway state"))
        }

        compose.runOnIdle { enabled.value = false }
        compose.onNodeWithText("project").performTouchInput { longClick() }
        for (label in listOf("Abort", "Compact", "Reload", "New session", "Restart", "Close gracefully")) compose.onNodeWithText(label).assertIsNotEnabled()
    }

    @Test fun exitedSessionsOfferDismissAndTheMenuNeverLeavesTheOverview() {
        val vm = vm()
        val exited = session(mapOf("dismiss" to null))
        val enabled = mutableStateOf(true)
        compose.setContent { MaterialTheme { SessionsScreen(vm, Dashboard(sessions = listOf(exited), updatedAt = 1L), enabled.value) } }

        compose.onNodeWithText("project").performTouchInput { longClick() }
        compose.onNodeWithText("Dismiss").assertIsDisplayed().assertIsEnabled()
        // Only what the host advertises: an exited session has no run control.
        for (label in listOf("Abort", "Compact", "Reload", "New session", "Restart", "Close gracefully")) compose.onNodeWithText(label).assertDoesNotExist()

        compose.onNodeWithText("Dismiss").performClick()
        compose.runOnIdle {
            assertEquals(Screen.Sessions, vm.screen.value)
            assertEquals(exited.id, vm.repository.state.value.selected)
            // The command path was entered; the unpaired test gateway rejects it before anything is sent.
            assertTrue(vm.repository.state.value.message.contains("Fresh gateway state"))
        }

        compose.runOnIdle { enabled.value = false }
        compose.onNodeWithText("project").performTouchInput { longClick() }
        compose.onNodeWithText("Dismiss").assertIsNotEnabled()
    }
}
