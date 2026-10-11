package dev.pidash.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** Drafts in memory, never the app's encrypted vault; the selected session is the test's. */
class DraftsTest {
    private class MemoryStorage : DraftStorage {
        val saves = mutableListOf<String>()
        override fun read() = saves.lastOrNull()
        override fun save(document: String) { saves += document }
    }
    private val storage = MemoryStorage()
    private var selected: String? = "a"
    /** A fresh run of the app over the same storage, showing the selected session. */
    private fun startApp() = Drafts(storage) { selected }.apply { restore(); open() }
    private fun saved(vararg drafts: Pair<String, String>) = JSONObject(mapOf(*drafts)).toString()
    private val prompts = listOf("first prompt", "second prompt")

    @Test fun browsingEarlierPromptsShowsThemWithoutReplacingTheTypedDraft() {
        val drafts = startApp()
        drafts.edit("unsent")
        val writes = storage.saves.size
        drafts.older(prompts)
        drafts.older(prompts)
        assertEquals("first prompt", drafts.text.value)
        assertEquals("browsing writes nothing", writes, storage.saves.size)
        assertEquals(saved("a" to "unsent"), storage.saves.last())

        // Leaving the session while an earlier prompt is shown, then coming back.
        selected = "b"; drafts.open()
        selected = "a"; drafts.open()
        assertEquals("unsent", drafts.text.value)

        // The app ends while an earlier prompt is shown.
        drafts.older(prompts)
        assertEquals("unsent", startApp().text.value)

        // Stepping down past the newest brings the draft back.
        drafts.newer(prompts)
        assertEquals("unsent", drafts.text.value)
        assertEquals(writes, storage.saves.size)
    }

    @Test fun editingOrSendingAShownPromptMakesItTheDraft() {
        val drafts = startApp()
        drafts.edit("unsent")
        drafts.older(prompts)
        drafts.edit("second prompt, edited")
        assertEquals(saved("a" to "second prompt, edited"), storage.saves.last())
        assertEquals("second prompt, edited", startApp().text.value)

        drafts.older(prompts)
        drafts.older(prompts)
        drafts.sent()
        assertEquals(saved("a" to "first prompt"), storage.saves.last())
        assertEquals("first prompt", startApp().text.value)
    }
}
