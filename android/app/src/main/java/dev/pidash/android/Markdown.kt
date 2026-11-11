package dev.pidash.android

/**
 * A bounded Markdown reader for assistant replies: block structure plus inline spans. It is not
 * CommonMark. Images are never loaded; an image's alt text is shown instead (PLAN-5).
 */
sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    data class Code(val language: String?, val code: String) : MdBlock
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<String>) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data object Rule : MdBlock
}

sealed interface MdSpan {
    data class Text(val text: String) : MdSpan
    data class Strong(val text: String) : MdSpan
    data class Emphasis(val text: String) : MdSpan
    data class Strikethrough(val text: String) : MdSpan
    data class Code(val text: String) : MdSpan
    data class Link(val text: String, val url: String) : MdSpan
}

object Markdown {
    private val heading = Regex("""^(#{1,6})\s+(.*)$""")
    private val fence = Regex("""^\s*(`{3,}|~{3,})\s*([^`\s]*)\s*$""")
    private val rule = Regex("""^\s*([-*_])(\s*\1){2,}\s*$""")
    private val quote = Regex("""^\s*>\s?(.*)$""")
    private val item = Regex("""^\s*([-*+]|\d{1,9}[.)])\s+(.*)$""")
    private val safeLink = Regex("""^(https?://|mailto:)""", RegexOption.IGNORE_CASE)

    /** Parses [text] into blocks; unclosed fences run to the end of the reply. */
    fun parse(text: String): List<MdBlock> {
        val lines = text.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val blocks = mutableListOf<MdBlock>()
        var index = 0
        while (index < lines.size) {
            val line = lines[index]
            if (line.isBlank()) { index++; continue }

            val fenceMatch = fence.matchEntire(line)
            if (fenceMatch != null) {
                val marker = fenceMatch.groupValues[1]
                val language = fenceMatch.groupValues[2].ifBlank { null }
                val code = mutableListOf<String>()
                index++
                while (index < lines.size && !lines[index].trimStart().startsWith(marker)) {
                    code += lines[index]
                    index++
                }
                // Skip the closing fence when present.
                if (index < lines.size) index++
                blocks += MdBlock.Code(language, code.joinToString("\n"))
                continue
            }

            val headingMatch = heading.matchEntire(line)
            if (headingMatch != null) {
                val level = headingMatch.groupValues[1].length
                val title = headingMatch.groupValues[2].trim().trimEnd('#').trimEnd()
                blocks += MdBlock.Heading(level, title)
                index++
                continue
            }

            if (rule.matches(line)) { blocks += MdBlock.Rule; index++; continue }

            if (quote.matches(line)) {
                val inner = mutableListOf<String>()
                while (index < lines.size) {
                    val quoted = quote.matchEntire(lines[index]) ?: break
                    inner += quoted.groupValues[1]
                    index++
                }
                blocks += MdBlock.Quote(parse(inner.joinToString("\n")))
                continue
            }

            val itemMatch = item.matchEntire(line)
            if (itemMatch != null) {
                val ordered = itemMatch.groupValues[1].first().isDigit()
                val start = if (ordered) itemMatch.groupValues[1].trimEnd('.', ')').toIntOrNull() ?: 1 else 1
                val items = mutableListOf<String>()
                while (index < lines.size) {
                    val current = lines[index]
                    val next = item.matchEntire(current)
                    when {
                        next != null && next.groupValues[1].first().isDigit() == ordered ->
                            items += next.groupValues[2].trim()
                        // Indented continuation lines belong to the previous item.
                        current.isNotBlank() && current.first().isWhitespace() && items.isNotEmpty() ->
                            items[items.lastIndex] = items.last() + " " + current.trim()
                        else -> break
                    }
                    index++
                }
                blocks += MdBlock.ListBlock(ordered, start, items)
                continue
            }

            // A paragraph runs until a blank line or the start of another block.
            val paragraph = mutableListOf<String>()
            while (index < lines.size) {
                val current = lines[index]
                if (current.isBlank() || fence.matchEntire(current) != null || heading.matchEntire(current) != null ||
                    rule.matches(current) || quote.matches(current) || item.matchEntire(current) != null) break
                paragraph += current.trim()
                index++
            }
            if (paragraph.isNotEmpty()) blocks += MdBlock.Paragraph(paragraph.joinToString(" "))
        }
        return blocks
    }

    /** Inline emphasis, code, links and images of one block of text. */
    fun inline(text: String): List<MdSpan> {
        val spans = mutableListOf<MdSpan>()
        val plain = StringBuilder()
        fun flush() {
            if (plain.isNotEmpty()) { spans += MdSpan.Text(plain.toString()); plain.clear() }
        }
        var index = 0
        while (index < text.length) {
            val char = text[index]
            when {
                char == '\\' && index + 1 < text.length -> {
                    plain.append(text[index + 1]); index += 2
                }
                char == '`' -> {
                    val end = text.indexOf('`', index + 1)
                    if (end > index + 1) {
                        flush(); spans += MdSpan.Code(text.substring(index + 1, end)); index = end + 1
                    } else { plain.append(char); index++ }
                }
                text.startsWith("![", index) -> {
                    val image = linkAt(text, index + 1)
                    // Never load an image; its alt text is the only safe thing to show.
                    if (image != null) { flush(); spans += MdSpan.Text(image.text); index = image.end } else { plain.append(char); index++ }
                }
                char == '[' -> {
                    val link = linkAt(text, index)
                    if (link != null) { flush(); spans += MdSpan.Link(link.text, link.url); index = link.end } else { plain.append(char); index++ }
                }
                text.startsWith("**", index) || text.startsWith("__", index) -> {
                    val delimiter = text.substring(index, index + 2)
                    val end = text.indexOf(delimiter, index + 2)
                    if (end > index + 2 && !text[index + 2].isWhitespace()) {
                        flush(); spans += MdSpan.Strong(text.substring(index + 2, end)); index = end + 2
                    } else { plain.append(char); index++ }
                }
                text.startsWith("~~", index) -> {
                    val end = text.indexOf("~~", index + 2)
                    if (end > index + 2) { flush(); spans += MdSpan.Strikethrough(text.substring(index + 2, end)); index = end + 2 }
                    else { plain.append(char); index++ }
                }
                char == '*' || char == '_' -> {
                    val end = text.indexOf(char, index + 1)
                    if (end > index + 1 && !text[index + 1].isWhitespace() && !text[end - 1].isWhitespace()) {
                        flush(); spans += MdSpan.Emphasis(text.substring(index + 1, end)); index = end + 1
                    } else { plain.append(char); index++ }
                }
                else -> { plain.append(char); index++ }
            }
        }
        flush()
        return spans
    }

    private class ParsedLink(val text: String, val url: String, val end: Int)

    /** `[label](url)` at [open]; only web and mail links become links, so no scheme is smuggled in. */
    private fun linkAt(text: String, open: Int): ParsedLink? {
        if (open >= text.length || text[open] != '[') return null
        val close = text.indexOf(']', open + 1)
        if (close <= open + 1 || close + 1 >= text.length || text[close + 1] != '(') return null
        val end = text.indexOf(')', close + 2)
        if (end <= close + 2) return null
        val label = text.substring(open + 1, close)
        // Drop an optional title after the URL.
        val url = text.substring(close + 2, end).trim().substringBefore(' ')
        return if (safeLink.containsMatchIn(url)) ParsedLink(label, url, end + 1) else null
    }

    /** The prefix of [reply] the card previews; the viewer shows the whole bounded reply. */
    fun preview(reply: String, limit: Int): String {
        if (reply.length <= limit) return reply
        val head = reply.substring(0, limit)
        return head.substringBeforeLast('\n', head)
    }
}
