package dev.pidash.android

import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTest {
    @Test fun parsesHeadingsParagraphsCodeListsQuotesAndRules() {
        val text = """
            # Title ###

            Some **bold** and `code`.

            ```sh
            echo hi
            ```

            - one
            - two
              continued

            1. first
            2. second

            > quoted **text**
            > second line

            ---
        """.trimIndent()
        assertEquals(listOf(
            MdBlock.Heading(1, "Title"),
            MdBlock.Paragraph("Some **bold** and `code`."),
            MdBlock.Code("sh", "echo hi"),
            MdBlock.ListBlock(ordered = false, start = 1, items = listOf("one", "two continued")),
            MdBlock.ListBlock(ordered = true, start = 1, items = listOf("first", "second")),
            MdBlock.Quote(listOf(MdBlock.Paragraph("quoted **text** second line"))),
            MdBlock.Rule,
        ), Markdown.parse(text))
    }

    @Test fun anUnclosedFenceRunsToTheEndAndAnOrderedListKeepsItsStart() {
        assertEquals(listOf(MdBlock.Code(null, "a\nb")), Markdown.parse("```\na\nb"))
        assertEquals(listOf(MdBlock.ListBlock(ordered = true, start = 3, items = listOf("third", "fourth"))), Markdown.parse("3. third\n4. fourth"))
    }

    @Test fun inlineEmphasisCodeStrikethroughAndSafeLinksAreSpans() {
        val spans = Markdown.inline("**bold** *it* `code` ~~gone~~ [site](https://example.com) [bad](javascript:alert(1)) ![alt](https://x/y.png) \\*literal\\*")
        assertEquals(listOf(
            MdSpan.Strong("bold"),
            MdSpan.Text(" "),
            MdSpan.Emphasis("it"),
            MdSpan.Text(" "),
            MdSpan.Code("code"),
            MdSpan.Text(" "),
            MdSpan.Strikethrough("gone"),
            MdSpan.Text(" "),
            MdSpan.Link("site", "https://example.com"),
            // An unsafe scheme stays literal text, and an image only contributes its alt text.
            MdSpan.Text(" [bad](javascript:alert(1)) "),
            MdSpan.Text("alt"),
            MdSpan.Text(" *literal*"),
        ), spans)
    }

    @Test fun unmatchedDelimitersStayLiteralAndUnderscoresEmphasise() {
        assertEquals(listOf(MdSpan.Text("*not closed")), Markdown.inline("*not closed"))
        assertEquals(listOf(MdSpan.Emphasis("x"), MdSpan.Text(" and "), MdSpan.Strong("y")), Markdown.inline("_x_ and __y__"))
        assertEquals(listOf(MdSpan.Text("a * b")), Markdown.inline("a * b"))
    }

    @Test fun previewCutsAtALineBoundaryAndKeepsShortRepliesWhole() {
        assertEquals("short", Markdown.preview("short", 100))
        assertEquals("line1\nline2", Markdown.preview("line1\nline2\nline3", 12))
        assertEquals("1234567890", Markdown.preview("1234567890abcdef", 10))
    }
}
