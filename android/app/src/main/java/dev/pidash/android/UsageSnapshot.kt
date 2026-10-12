package dev.pidash.android

/** A report and its monotonic receipt time, retained together by the ViewModel, not the composition. */
data class UsageSnapshot(val report: UsageReport, val receivedAt: Long) {
    fun hostTime(elapsedRealtime: Long): Long = report.at + (elapsedRealtime - receivedAt)
}
