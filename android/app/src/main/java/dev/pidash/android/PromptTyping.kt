package dev.pidash.android

/** Punctuation that can close a sentence. */
private const val SENTENCE_END = ".!?"

/** Characters that may sit before a sentence's first letter: quotes, brackets, emphasis, headings and list markers. */
private const val SENTENCE_LEAD = "\"'`([{<*_-#>+"

/** Characters that may close a sentence before the next one starts. */
private const val SENTENCE_CLOSE = "\"'`)]}>*_"

/**
 * Capitalizes the first letter of the text and of every new sentence, for the prompt field when
 * sentence capitalization is on. A sentence starts at the beginning, after '.', '!' or '?' followed
 * by a space or the end of the text, and after a line break. Only letter case changes, so the text
 * keeps its length and a cursor or composing range stays valid. A full stop inside a word ("3.5",
 * "example.com") or an abbreviation ("e.g.", "U.S.") does not start a new sentence.
 */
fun capitalizeSentences(text: String): String {
    val chars = text.toCharArray()
    var waiting = true
    for (index in chars.indices) {
        val char = chars[index]
        when {
            char.isLetter() -> {
                if (waiting) chars[index] = char.uppercaseChar()
                waiting = false
            }
            char == '\n' || char == '\r' -> waiting = true
            char in SENTENCE_END -> waiting = endsSentence(chars, index)
            char.isWhitespace() || char in SENTENCE_LEAD -> Unit
            else -> waiting = false
        }
    }
    return String(chars)
}

/** Whether the punctuation at [index] closes a sentence rather than sitting inside a word or abbreviation. */
private fun endsSentence(chars: CharArray, index: Int): Boolean {
    var next = index + 1
    while (next < chars.size && chars[next] in SENTENCE_CLOSE) next++
    if (next < chars.size && !chars[next].isWhitespace() && chars[next] !in SENTENCE_END) return false
    // "e.g." and "U.S.": a full stop after a one-letter segment that follows another full stop is not a sentence end.
    if (chars[index] == '.' && index >= 2 && chars[index - 1].isLetter() && chars[index - 2] == '.') return false
    return true
}
