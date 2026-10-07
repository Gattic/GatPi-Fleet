package dev.pidash.g1

/** In-memory metadata only; never records display payloads or device addresses. */
object G1Diagnostics {
    private val entries = ArrayDeque<String>()
    @Synchronized fun record(message: String) {
        if (entries.size == 100) entries.removeFirst()
        entries.addLast(message.take(160))
    }
    @Synchronized fun snapshot(): String = entries.joinToString("\n")
}
