package dev.pidash.android

/**
 * Commands matching a draft that starts with a slash command name: the built-ins pi-dash can run,
 * then Pi's extension commands, prompt templates and skills. Once the draft has arguments the list
 * is empty, since arguments are typed rather than chosen. Skills also match their bare name, as
 * Pi's own command menu does.
 */
fun slashSuggestions(commands: List<SlashCommand>, draft: String, limit: Int = 8): List<SlashCommand> {
    val text = draft.trimStart()
    if (!text.startsWith("/")) return emptyList()
    val query = text.substring(1)
    if (query.any(Char::isWhitespace)) return emptyList()
    if (query.isEmpty()) return commands.take(limit)
    val prefix = commands.filter { matches(it, query, prefixOnly = true) }
    val contains = commands.filter { it !in prefix && matches(it, query, prefixOnly = false) }
    return (prefix + contains).take(limit)
}

private fun matches(command: SlashCommand, query: String, prefixOnly: Boolean): Boolean =
    listOf(command.name, command.name.removePrefix("skill:")).any { name ->
        if (prefixOnly) name.startsWith(query, ignoreCase = true) else name.contains(query, ignoreCase = true)
    }
