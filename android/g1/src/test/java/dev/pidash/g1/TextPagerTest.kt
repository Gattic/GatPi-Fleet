package dev.pidash.g1

import org.junit.Assert.assertEquals
import org.junit.Test

class TextPagerTest {
    /** Every character is 10 px wide, so a 100 px line holds 10 characters. */
    private val pager = TextPager(measure = { it.length * 10f }, maxWidth = 100f)

    @Test
    fun wrapsAtWordBoundaries() {
        assertEquals(listOf("aaaa bbbb", "cccc"), pager.lines("aaaa bbbb cccc"))
    }

    @Test
    fun splitsWordsWiderThanALine() {
        assertEquals(listOf("abcdefghij", "klmnop"), pager.lines("abcdefghijklmnop"))
        assertEquals(listOf("ab", "cdefghijkl", "mnop"), pager.lines("ab cdefghijklmnop"))
    }

    @Test
    fun dropsBlankParagraphsAndTrims() {
        assertEquals(listOf("a", "b"), pager.lines("  a \n\n   \n b "))
    }

    @Test
    fun paginatesFiveLinesPerScreen() {
        val text = (1..12).joinToString("\n") { "L$it" }
        assertEquals(
            listOf("L1\nL2\nL3\nL4\nL5\n", "L6\nL7\nL8\nL9\nL10\n", "L11\nL12\n"),
            pager.pages(text),
        )
    }

    @Test
    fun centresAShortSingleScreenLikeTheDemo() {
        assertEquals(listOf("\n\nL1\nL2\nL3\n"), pager.pages("L1\nL2\nL3"))
        assertEquals(listOf("\nL1\nL2\nL3\nL4\n"), pager.pages("L1\nL2\nL3\nL4"))
        assertEquals(listOf("L1\nL2\nL3\nL4\nL5\n"), pager.pages("L1\nL2\nL3\nL4\nL5"))
    }

    @Test
    fun startsAParagraphOnTheNextScreenRatherThanSplitItLate() {
        val three = "aaaa bbbb cccc dddd eeee ffff" // 3 lines
        assertEquals(
            listOf("L1\nL2\nL3\n", "aaaa bbbb\ncccc dddd\neeee ffff\n"),
            pager.pages(listOf("L1", "L2", "L3", three)),
        )
    }

    @Test
    fun keepsFillingAScreenThatIsLessThanHalfFull() {
        val four = "aaaa bbbb cccc dddd eeee ffff gggg hhhh" // 4 lines
        assertEquals(
            listOf("L1\nL2\naaaa bbbb\ncccc dddd\neeee ffff\n", "gggg hhhh\n"),
            pager.pages(listOf("L1", "L2", four)),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsTextWithNothingToShow() {
        pager.pages(" \n ")
    }
}
