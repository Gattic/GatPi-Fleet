// Splits text into G1 screens the way EvenDemoApp does: lines wrapped to the
// 488 px text width at font size 21 (EvenAIDataMethod.measureStringList), five
// lines per screen (TextService). Paragraphs avoid splitting across screens as
// the G1 proof of concept's pager does. Width measurement is injected so the app can
// use an Android Paint while tests use a fixed-width fake.

package dev.pidash.g1

class TextPager(
    private val measure: (String) -> Float,
    private val maxWidth: Float = MAX_WIDTH,
) {
    /** Non-empty paragraphs, each wrapped at word boundaries; words wider than a line are split. */
    fun lines(text: String): List<String> =
        text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.flatMap(::wrap)

    /** Screens for text whose lines are paragraphs; see the other overload. */
    fun pages(text: String): List<String> = pages(text.split('\n'))

    /**
     * Screens of up to [LINES_PER_PAGE] lines, each line terminated by '\n'. A paragraph
     * that does not fit the rest of a screen starts the next one if it fits there whole
     * and the current screen is at least half full; otherwise it flows on.
     */
    fun pages(paragraphs: List<String>): List<String> {
        val screens = mutableListOf<List<String>>()
        var screen = mutableListOf<String>()
        for (paragraph in paragraphs) {
            val lines = lines(paragraph)
            if (lines.isEmpty()) continue
            val keepWhole = lines.size <= LINES_PER_PAGE && screen.size * 2 >= LINES_PER_PAGE
            if (screen.size + lines.size > LINES_PER_PAGE && keepWhole) {
                screens += screen
                screen = mutableListOf()
            }
            for (line in lines) {
                if (screen.size == LINES_PER_PAGE) {
                    screens += screen
                    screen = mutableListOf()
                }
                screen += line
            }
        }
        if (screen.isNotEmpty()) screens += screen
        require(screens.isNotEmpty()) { "nothing to show" }
        val pages = screens.map { page -> page.joinToString("") { "$it\n" } }
        if (pages.size > 1) return pages
        // TextService.startSendText centres a short single screen with leading blank lines.
        val padding = when (screens.single().size) {
            in 1..3 -> "\n\n"
            4 -> "\n"
            else -> ""
        }
        return listOf(padding + pages.single())
    }

    private fun wrap(paragraph: String): List<String> {
        val wrapped = mutableListOf<String>()
        var line = ""
        for (word in paragraph.split(Regex(" +"))) {
            val candidate = if (line.isEmpty()) word else "$line $word"
            if (measure(candidate) <= maxWidth) {
                line = candidate
                continue
            }
            if (line.isNotEmpty()) wrapped += line
            line = word
            while (measure(line) > maxWidth) {
                val fit = longestFittingPrefix(line)
                wrapped += line.substring(0, fit)
                line = line.substring(fit)
            }
        }
        if (line.isNotEmpty()) wrapped += line
        return wrapped
    }

    private fun longestFittingPrefix(word: String): Int {
        var length = 1
        while (length < word.length && measure(word.substring(0, length + 1)) <= maxWidth) length++
        return length
    }

    companion object {
        const val MAX_WIDTH = 488f
        const val FONT_SIZE = 21f
        const val LINES_PER_PAGE = 5
    }
}
