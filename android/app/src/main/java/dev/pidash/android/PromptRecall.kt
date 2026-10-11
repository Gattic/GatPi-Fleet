package dev.pidash.android

/**
 * Steps through a session's earlier prompts (oldest first) like pi's editor history: [older] and [newer]
 * replace the draft with the previous or next prompt, and stepping past the newest brings back the draft
 * the first step replaced. [position] is the prompt shown, or null when not browsing.
 */
data class PromptRecall(val position: Int? = null, val draft: String = "") {
    // The list can shrink while browsing: its oldest prompts give way to new ones.
    private fun start(prompts: List<String>) = minOf(position ?: prompts.size, prompts.size)

    fun canOlder(prompts: List<String>) = start(prompts) > 0
    val canNewer: Boolean get() = position != null

    /** The recall one prompt older and the text to show, or null at the oldest. */
    fun older(prompts: List<String>, current: String): Pair<PromptRecall, String>? {
        if (!canOlder(prompts)) return null
        val next = start(prompts) - 1
        return PromptRecall(next, if (position == null) current else draft) to prompts[next]
    }

    /** The recall one prompt newer and the text to show, or null when not browsing. */
    fun newer(prompts: List<String>): Pair<PromptRecall, String>? {
        val next = (position ?: return null) + 1
        return if (next < prompts.size) copy(position = next) to prompts[next] else PromptRecall() to draft
    }
}
