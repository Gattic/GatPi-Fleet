package dev.pidash.android

import org.junit.Assert.assertEquals
import org.junit.Test

class SlashCommandsTest {
    private val commands = listOf(
        SlashCommand("model", "Switch model", "<provider/modelId>", "builtin"),
        SlashCommand("compact", "Compact now", "[instructions]", "builtin"),
        SlashCommand("review", "Review the diff", null, "prompt"),
        SlashCommand("skill:character-garment-fitting", "Fit garments", null, "skill"),
        SlashCommand("skill:commit", "Commit work", null, "skill"),
    )

    @Test fun slashAloneListsTheCommandsInPublishedOrder() {
        assertEquals(commands.take(8), slashSuggestions(commands, "/"))
        assertEquals(commands.take(8), slashSuggestions(commands, "  /"))
    }

    @Test fun aPrefixMatchesNamesCaseInsensitively() {
        assertEquals(listOf(commands[1], commands[4]), slashSuggestions(commands, "/COM"))
        assertEquals(listOf(commands[0]), slashSuggestions(commands, "/mod"))
    }

    @Test fun aSkillMatchesItsBareNameAndItsFullName() {
        assertEquals(listOf(commands[3]), slashSuggestions(commands, "/character"))
        assertEquals(listOf(commands[3]), slashSuggestions(commands, "/skill:character"))
    }

    @Test fun prefixMatchesComeBeforeContainsMatches() {
        // "commit" starts with "co" (skill:commit) and "compact" contains it later in its name? No: compact starts with "co".
        assertEquals(listOf(commands[1], commands[4]), slashSuggestions(commands, "/co"))
    }

    @Test fun argumentsEndTheList() {
        assertEquals(emptyList<SlashCommand>(), slashSuggestions(commands, "/model anthropic/"))
        assertEquals(emptyList<SlashCommand>(), slashSuggestions(commands, "/skill:commit now"))
    }

    @Test fun textWithoutASlashHasNoSuggestions() {
        assertEquals(emptyList<SlashCommand>(), slashSuggestions(commands, "run /model"))
        assertEquals(emptyList<SlashCommand>(), slashSuggestions(commands, "fix the tests"))
    }

    @Test fun theListIsLimited() {
        assertEquals(commands.take(2), slashSuggestions(commands, "/", limit = 2))
    }
}
