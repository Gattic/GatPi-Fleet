package dev.pidash.android.ui

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.Dashboard
import dev.pidash.android.Detail
import dev.pidash.android.DraftStorage
import dev.pidash.android.Drafts
import dev.pidash.android.Plan
import dev.pidash.android.Session
import dev.pidash.android.Tool
import org.junit.Rule
import org.junit.Test

/** Real session detail and view model with synthetic data: no pairing, host request or command. */
class SessionTabsTest {
    @get:Rule val compose = createComposeRule()

    private val session = Session("s", "r", "project", "/work/project", "working", "working", null, null, true,
        "anthropic/claude", "high", 42.0, Plan("Ship it", 3, 8, "Write the tests"), null, 1234.0, 0.5,
        mapOf("prompt" to null, "ask" to null))
    private val detail = Detail(session, "Run the tests", emptyList(), "All green", null, null, emptyList(), emptyList(),
        listOf(Tool("bash", "npm test", "{\"command\":\"npm test\"}", "all green", 1000L, 2500L, false)))

    @Test fun headerStaysWhileEachTabShowsItsOwnSectionsAndKeepsItsState() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val vm = DashViewModel(app, Drafts(object : DraftStorage {
            override fun read(): String? = null
            override fun save(document: String) = Unit
        }) { session.id })
        compose.setContent { MaterialTheme { SessionScreen(vm, Dashboard(detail = detail, fresh = true), enabled = true) } }

        // Chat opens first: the latest exchange and the composer, nothing else.
        compose.onNodeWithText("Chat").assertIsSelected()
        compose.onNodeWithText("All green").assertIsDisplayed()
        compose.onNodeWithTag("prompt-field").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("RECENT TOOLS").assertDoesNotExist()
        compose.onNodeWithText("RUN CONTROL").assertDoesNotExist()

        compose.onNodeWithText("Activity").performClick()
        compose.onNodeWithText("ROADMAP").assertIsDisplayed()
        compose.onNodeWithTag("tool-bash").performScrollTo().performClick()
        compose.onNodeWithText("{\"command\":\"npm test\"}").assertIsDisplayed()
        compose.onNodeWithText("RESOURCES").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("prompt-field").assertDoesNotExist()

        compose.onNodeWithText("Ask").performClick()
        compose.onNodeWithText("SIDE QUESTION").assertIsDisplayed()

        compose.onNodeWithText("Manage").performClick()
        compose.onNodeWithText("RUN CONTROL").assertIsDisplayed()
        compose.onNodeWithText("MODEL").performScrollTo().assertIsDisplayed()

        // Status, model, context and plan progress stay in view on every tab.
        compose.onNodeWithText("anthropic/claude · thinking high").assertIsDisplayed()
        compose.onNodeWithText("CTX 42%").assertIsDisplayed()
        compose.onNodeWithText("Write the tests").assertIsDisplayed()

        // Returning to a tab restores it as it was left: the expanded tool run is still open.
        compose.onNodeWithText("Activity").performClick()
        compose.onNodeWithText("{\"command\":\"npm test\"}").performScrollTo().assertIsDisplayed()
    }
}
