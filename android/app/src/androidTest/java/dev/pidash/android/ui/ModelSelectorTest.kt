package dev.pidash.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.AnnotatedString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Isolated selector: no view model, host commands, app vault or provider requests. */
class ModelSelectorTest {
    @get:Rule val compose = createComposeRule()
    private val sol = "openai-codex/gpt-6.1-sol"
    private val current = "anthropic/claude-opus-5-5"
    private val models = listOf(current, "openai-codex/gpt-6-sol", sol, "openrouter/openai/gpt-6.1-sol")
    private val selected = mutableListOf<String>()

    @Test fun typingKeepsKeyboardFocusAndOnlySelectingASuggestionChangesTheModel() {
        compose.setContent { MaterialTheme { ModelSelector("session", current, models, true, selected::add) } }
        val search = compose.onNodeWithText("Search models").performClick()
        search.performTextInput("sol")
        search.assertIsFocused().performTextInput(" 6.1")
        compose.onNodeWithText(sol).assertIsDisplayed()
        compose.onNodeWithText(models[1]).assertDoesNotExist()
        compose.runOnIdle { assertTrue(selected.isEmpty()) }
        compose.onNodeWithText(sol).performClick()
        compose.runOnIdle { assertEquals(listOf(sol), selected) }
        search.assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithText("Current: $current").assertIsDisplayed()
        compose.onNodeWithText(sol).assertDoesNotExist()
    }

    @Test fun noMatchesCanBeClearedWithoutSelectingOrSubmittingArbitraryText() {
        compose.setContent { MaterialTheme { ModelSelector("session", current, models, true, selected::add) } }
        val search = compose.onNodeWithText("Search models").performClick()
        search.performTextInput("not-available")
        compose.onNodeWithText("No matching models").assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithContentDescription("Clear model search").performClick()
        compose.onNodeWithText("No matching models").assertDoesNotExist()
        compose.onNodeWithText(sol).assertIsDisplayed()
        search.performTextReplacement("codex sol 6.1")
        compose.onNodeWithText(models.last()).assertDoesNotExist()
        compose.onNodeWithText(sol).assertIsDisplayed()
        compose.runOnIdle { assertTrue(selected.isEmpty()) }
    }

    @Test fun losingCommandPermissionClosesTheMenuAndDisablesSearch() {
        val enabled = mutableStateOf(true)
        compose.setContent { MaterialTheme { ModelSelector("session", current, models, enabled.value, selected::add) } }
        val search = compose.onNodeWithText("Search models").performClick()
        search.performTextInput("sol 6.1")
        compose.onNodeWithText(sol).assertIsDisplayed()
        compose.runOnUiThread { enabled.value = false }
        search.assertIsNotEnabled()
        compose.onNodeWithText(sol).assertDoesNotExist()
        compose.runOnIdle { assertTrue(selected.isEmpty()) }
    }

    @Test fun changingSessionOrCurrentModelResetsTheSearchAndClosesSuggestions() {
        val session = mutableStateOf("first")
        val model = mutableStateOf(current)
        compose.setContent { MaterialTheme { ModelSelector(session.value, model.value, models, true, selected::add) } }
        val search = compose.onNodeWithText("Search models").performClick()
        search.performTextInput("sol 6.1")
        compose.runOnUiThread { session.value = "second" }
        search.assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithText(sol).assertDoesNotExist()
        search.performTextInput("opus")
        compose.runOnUiThread { model.value = sol }
        search.assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithText("Current: $sol").assertIsDisplayed()
        compose.runOnIdle { assertTrue(selected.isEmpty()) }
    }

    @Test fun emptyCatalogExplainsWhyThereAreNoSuggestions() {
        compose.setContent { MaterialTheme { ModelSelector("session", null, emptyList(), true, selected::add) } }
        compose.onNodeWithText("Search models").performClick().performTextInput("sol 6.1")
        compose.onNodeWithText("No models available for this session").assertIsDisplayed().assertIsNotEnabled()
        compose.runOnIdle { assertTrue(selected.isEmpty()) }
    }
}
