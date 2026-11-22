package dev.pidash.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SuggestionCommandTest {
    @Test fun aPlainSuggestionRequestCarriesNoDirection() {
        val command = suggestionCommand("")
        assertEquals("suggest", command.getString("kind"))
        assertFalse(command.has("direction"))
    }

    @Test fun aDirectionIsTrimmedAndCarriedWithTheRequest() {
        val command = suggestionCommand("  focus on the failing tests  ")
        assertEquals("suggest", command.getString("kind"))
        assertEquals("focus on the failing tests", command.getString("direction"))
    }

    @Test fun aBlankDirectionIsOmittedRatherThanRejectedByTheGateway() {
        assertFalse(suggestionCommand("   ").has("direction"))
    }
}
