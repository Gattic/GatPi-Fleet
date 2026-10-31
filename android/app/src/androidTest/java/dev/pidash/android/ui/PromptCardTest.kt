package dev.pidash.android.ui

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.Dashboard
import dev.pidash.android.Detail
import dev.pidash.android.DraftStorage
import dev.pidash.android.Drafts
import dev.pidash.android.Session
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Real session detail and view model with drafts in memory: the app's encrypted drafts and the host are not touched. */
class PromptCardTest {
    @get:Rule val compose = createComposeRule()
    private val session = Session("s", "r", "project", "/work/project", "ready", "ready", null, null, true, null, null, null, null, null, null, null, mapOf("prompt" to null))
    private fun detail(prompts: List<String>) = Detail(session, null, prompts, null, null, null, emptyList(), emptyList(), emptyList())
    private val saves = mutableListOf<String>()
    private val storage = object : DraftStorage {
        override fun read() = saves.lastOrNull()
        override fun save(document: String) { saves += document }
    }

    @Test fun suggestionRequestIsGatedAndIncomingSuggestionsNeverReplaceADraft() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val vm = DashViewModel(app, Drafts(storage) { session.id })
        val current = mutableStateOf(session.copy(commands = mapOf("prompt" to null, "suggest" to null)))
        val suggestion = mutableStateOf<String?>(null)
        val enabled = mutableStateOf(true)
        vm.drafts.edit("Keep my draft")
        compose.setContent {
            MaterialTheme { SessionScreen(vm, Dashboard(detail = detail(emptyList()).copy(session = current.value, suggestion = suggestion.value)), enabled.value) }
        }
        compose.onNodeWithText("New prompt suggestion").performScrollTo().assertIsEnabled()
        compose.onNodeWithText("Edit suggested prompt").assertDoesNotExist()
        compose.runOnIdle { suggestion.value = "Inspect the next task" }
        compose.onNodeWithText("Edit suggested prompt").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals("Keep my draft", vm.drafts.text.value) }
        compose.onNodeWithText("Edit suggested prompt").performClick()
        compose.runOnIdle { assertEquals("Inspect the next task", vm.drafts.text.value) }
        compose.runOnIdle { suggestion.value = "Run focused tests" }
        compose.runOnIdle { assertEquals("Inspect the next task", vm.drafts.text.value) }
        compose.runOnIdle { enabled.value = false }
        compose.onNodeWithText("New prompt suggestion").assertIsNotEnabled()
        compose.runOnIdle { enabled.value = true; current.value = session.copy(commands = mapOf("suggest" to "Only while idle")) }
        compose.onNodeWithText("New prompt suggestion").assertIsNotEnabled()
        compose.runOnIdle { current.value = session }
        compose.onNodeWithText("New prompt suggestion").assertIsNotEnabled()
    }

    @Test fun recalledPromptsAreOnlyShownAndTypingAddsToTheirEnd() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val vm = DashViewModel(app, Drafts(storage) { session.id })
        compose.setContent { MaterialTheme { SessionScreen(vm, Dashboard(detail = detail(listOf("gamma typed in pi", "delta prompt"))), enabled = true) } }
        val field = compose.onNodeWithText("Prompt / unsent draft").performScrollTo()
        field.performTextInput("draft")
        compose.onNodeWithContentDescription("Older prompt").performClick()
        field.assert(hasText("delta prompt"))
        // Longer than where the cursor was in the earlier texts.
        compose.onNodeWithContentDescription("Older prompt").performClick()
        compose.onNodeWithText("Earlier prompt 1 of 2").assertIsDisplayed()
        compose.runOnIdle { assertEquals(JSONObject(mapOf("s" to "draft")).toString(), saves.last()) }
        field.performTextInput(" edited")
        field.assert(hasText("gamma typed in pi edited"))
        compose.onNodeWithText("Earlier prompt", substring = true).assertDoesNotExist()
        compose.runOnIdle { assertEquals(JSONObject(mapOf("s" to "gamma typed in pi edited")).toString(), saves.last()) }
    }
}
