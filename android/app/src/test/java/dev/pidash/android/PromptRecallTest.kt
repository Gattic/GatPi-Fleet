package dev.pidash.android

import org.junit.Assert.*
import org.junit.Test

class PromptRecallTest {
    private val prompts = listOf("first", "second", "third")

    @Test fun stepsBackToTheOldestThenForwardToTheDraftItReplaced() {
        var recall = PromptRecall()
        assertFalse(recall.canNewer)
        val shown = mutableListOf<String>()
        while (recall.canOlder(prompts)) recall.older(prompts, "unsent")!!.let { (next, text) -> recall = next; shown += text }
        assertEquals(listOf("third", "second", "first"), shown)
        assertNull(recall.older(prompts, "first"))
        shown.clear()
        while (recall.canNewer) recall.newer(prompts)!!.let { (next, text) -> recall = next; shown += text }
        assertEquals(listOf("second", "third", "unsent"), shown)
        assertEquals(PromptRecall(), recall)
        assertNull(recall.newer(prompts))
    }

    @Test fun withoutEarlierPromptsThereIsNothingToRecall() {
        assertFalse(PromptRecall().canOlder(emptyList()))
        assertNull(PromptRecall().older(emptyList(), "draft"))
    }

    @Test fun aListThatShrankWhileBrowsingContinuesFromItsNewest() {
        val (recall, text) = PromptRecall(position = 5, draft = "unsent").older(prompts, "ignored")!!
        assertEquals("third", text)
        assertEquals(PromptRecall(2, "unsent"), recall)
    }
}
