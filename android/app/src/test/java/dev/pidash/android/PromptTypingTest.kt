package dev.pidash.android

import org.junit.Assert.assertEquals
import org.junit.Test

class PromptTypingTest {
    @Test fun theFirstLetterAndEverySentenceStartIsCapitalized() {
        assertEquals("Review the diff. Then run the tests! Why?", capitalizeSentences("review the diff. then run the tests! why?"))
    }

    @Test fun lineBreaksStartSentences() {
        assertEquals("First line\nSecond line\n  Indented", capitalizeSentences("first line\nsecond line\n  indented"))
    }

    @Test fun quotesBracketsEmphasisAndListMarkersAreSkipped() {
        assertEquals("\"Quoted\" (bracketed) *emphasised* - listed # heading > quoted", capitalizeSentences("\"quoted\" (bracketed) *emphasised* - listed # heading > quoted"))
    }

    @Test fun fullStopsInsideWordsAndAbbreviationsDoNotStartSentences() {
        assertEquals("Version 3.5 ships in example.com. See e.g. the docs. Then stop.",
            capitalizeSentences("version 3.5 ships in example.com. see e.g. the docs. then stop."))
    }

    @Test fun nonLettersAfterAFullStopWaitForTheNextLetter() {
        assertEquals("Ends. 2 things happen. Then this", capitalizeSentences("ends. 2 things happen. then this"))
    }

    @Test fun alreadyCapitalizedTextIsUnchangedAndLengthIsKept() {
        val text = "Hello world. It stays. As typed.\nFine."
        assertEquals(text, capitalizeSentences(text))
        assertEquals(text.length, capitalizeSentences("hello world. it stays. as typed.\nfine.").length)
    }

    @Test fun emptyTextStaysEmpty() {
        assertEquals("", capitalizeSentences(""))
    }
}
