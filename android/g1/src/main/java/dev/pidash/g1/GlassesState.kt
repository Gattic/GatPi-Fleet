package dev.pidash.g1

enum class DisplayStatus { IDLE, PENDING, ACKNOWLEDGED, FAILED }

data class GlassesState(
    val session: String = "stopped", val left: String = "-", val right: String = "-",
    val page: Int = 0, val pageCount: Int = 0, val silent: Boolean = false,
    val dismissed: Boolean = false, val displayStatus: DisplayStatus = DisplayStatus.IDLE,
    val displayRevision: Long = 0,
    val pairs: List<String> = emptyList(), val error: String? = null,
) {
    fun stopped() = GlassesState(error = error)
    fun connectionSummary() = "$session · L $left · R $right"

    /** A new selection, suppression or link loss invalidates acknowledgments already in flight. */
    fun pendingDisplay() = copy(
        displayRevision = displayRevision + 1,
        displayStatus = if (page > 0 && !silent && !dismissed) DisplayStatus.PENDING else DisplayStatus.IDLE,
    )

    fun finishDisplay(revision: Long, acknowledged: Boolean): GlassesState {
        if (revision != displayRevision || page == 0 || silent || dismissed || left != "ready" || right != "ready") return this
        return copy(displayStatus = if (acknowledged) DisplayStatus.ACKNOWLEDGED else DisplayStatus.FAILED)
    }
}
