package dev.pidash.android

import dev.pidash.android.ui.modelSuggestions
import org.junit.Assert.assertEquals
import org.junit.Test

class ModelSuggestionsTest {
    private val sol = "openai-codex/gpt-6.1-sol"
    private val models = listOf("anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", sol, "openrouter/openai/gpt-6.1-sol")

    @Test fun solNameAndVersionMatchInEitherOrderWithoutCaseSensitivity() {
        val expected = listOf(sol, models.last())
        assertEquals(expected, modelSuggestions(models, "sol 6.1"))
        assertEquals(expected, modelSuggestions(models, "  6.1 \t SOL  "))
    }

    @Test fun providerAndFullIdCanDisambiguateTheSameModel() {
        assertEquals(listOf(sol), modelSuggestions(models, "codex sol 6.1"))
        assertEquals(listOf(models.last()), modelSuggestions(models, "openrouter/openai/gpt-6.1-sol"))
    }

    @Test fun clearingTheSearchRestoresEveryModelInHostOrder() {
        assertEquals(models, modelSuggestions(models, ""))
        assertEquals(models, modelSuggestions(models, " \t\n "))
    }

    @Test fun searchesTheWholeCatalogIncludingItsLastEntry() {
        val catalog = (0 until 1000).map { "provider/model-$it" } + sol
        assertEquals(listOf(sol), modelSuggestions(catalog, "sol 6.1"))
    }

    @Test fun everySearchWordMustMatchAndEmptyCatalogsStayEmpty() {
        assertEquals(emptyList<String>(), modelSuggestions(models, "anthropic sol"))
        assertEquals(emptyList<String>(), modelSuggestions(models, "not-an-available-model"))
        assertEquals(emptyList<String>(), modelSuggestions(emptyList(), "sol 6.1"))
    }
}
