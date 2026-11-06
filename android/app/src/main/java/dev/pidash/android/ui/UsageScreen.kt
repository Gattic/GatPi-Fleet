package dev.pidash.android.ui

import android.os.SystemClock
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.DashViewModel
import dev.pidash.android.Metric
import dev.pidash.android.RemoteUsageHost
import dev.pidash.android.UsageItem
import dev.pidash.android.UsageRange
import dev.pidash.android.UsageReport
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay
import kotlin.math.roundToInt
import kotlin.math.roundToLong

private val RANGE_LABELS = mapOf("today" to "Today", "7d" to "7 days", "30d" to "30 days")

/** Account quota availability and cooldowns, then session cost or tokens over time. */
@Composable
internal fun UsageScreen(vm: DashViewModel, fresh: Boolean) {
    val snapshot = vm.usage.collectAsStateWithLifecycle().value
    val report = snapshot?.report
    val range by vm.usageRange.collectAsStateWithLifecycle()
    val metric by vm.usageMetric.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    // Only the ticker belongs to this composition; recreating it must not renew the cached report.
    var now by remember(snapshot) { mutableLongStateOf(snapshot?.hostTime(SystemClock.elapsedRealtime()) ?: 0L) }
    LaunchedEffect(snapshot) {
        val received = snapshot ?: return@LaunchedEffect
        while (true) {
            now = received.hostTime(SystemClock.elapsedRealtime())
            delay(1000)
        }
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Usage", style = MaterialTheme.typography.headlineSmall)
                    Text(report?.let { "pi's API usage on the host${if (it.hosts.isEmpty()) "" else " and its remote hosts"}, as of ${clock(it.at)}" } ?: "pi's API usage on the host",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = vm::refreshUsage, enabled = fresh && !busy) { Icon(Icons.Filled.Refresh, "Refresh usage") }
            }
        }
        if (report == null) {
            if (!busy) item { Hint("Usage was not loaded. Refresh to try again.") }
            return@LazyColumn
        }
        if (report.indexing) item { Hint("Indexing session files; totals are still growing.") }
        item { QuotaCard(report, now) }
        item { CooldownCard(report) }
        item { Selection(range, metric, onRange = { vm.usageRange.value = it }, onMetric = { vm.usageMetric.value = it }) }
        val selected = report.range(range)
        item { TotalCard(selected, metric) }
        if (report.hosts.isNotEmpty()) item { HostsCard(selected, metric, report.hosts, vm.repository.host()?.removePrefix("https://") ?: "Gateway host") }
        item { SessionsCard(selected.measure(metric).sessions, metric, report.indexing) }
        item { ModelsCard(selected, metric) }
        item {
            Hint("$ is pi's API-equivalent cost, not a subscription invoice; unpriced models count in tokens only. " +
                "Subagents count toward the session that spawned them. Counts the session files of the host and its remote hosts; " +
                "quotas and cooldowns are the host's own logins. 30 days kept.")
        }
    }
}

@Composable
private fun QuotaCard(report: UsageReport, now: Long) {
    SectionCard("Account quotas") {
        val accounts = report.quota
        when {
            accounts == null -> Hint("Unknown — login list unavailable.", icon = null)
            accounts.isEmpty() -> Hint("No logins", icon = null)
            else -> accounts.forEach { account ->
                val fresh = account.fresh(now)
                Text(account.provider, style = MaterialTheme.typography.titleSmall)
                if (account.windows.isEmpty()) Hint("${account.status} — ${account.message.orEmpty()}", icon = null)
                else {
                    if (!fresh) Hint("Stale — ${account.message ?: "refresh to update"}", icon = null)
                    account.windows.forEach { window ->
                        val left = (100 - window.usedPercent).roundToInt()
                        val color = if (!fresh) MaterialTheme.colorScheme.onSurfaceVariant else if (left <= 10) MaterialTheme.colorScheme.error else if (left <= 30) Pi.Waiting else MaterialTheme.colorScheme.primary
                        Text("${window.label}: $left% left", color = color)
                        LinearProgressIndicator(progress = { ((100 - window.usedPercent) / 100).toFloat() }, modifier = Modifier.fillMaxWidth(), color = color)
                        Text(when {
                            window.resetAt == null -> "Reset time not reported"
                            window.resetAt > now -> "Resets in ${duration(window.resetAt - now)}"
                            else -> "Reset due — refresh to update"
                        }, style = MaterialTheme.typography.bodySmall)
                    }
                    Text("Updated ${duration((now - (account.fetchedAt ?: now)).coerceAtLeast(0))} ago", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        Hint("Provider-reported subscription usage, not a guarantee the next request will succeed.", icon = null)
    }
}

@Composable
private fun CooldownCard(report: UsageReport) {
    SectionCard("Account cooldowns") {
        val cooldowns = report.cooldowns
        when {
            cooldowns == null -> Hint("Unknown — account state unavailable.", icon = null)
            cooldowns.isEmpty() -> Hint("None recorded.", icon = null)
            else -> cooldowns.forEach {
                Text("${it.provider}: ${duration(it.until - report.at)} at last refresh", style = MaterialTheme.typography.bodyMedium, color = Pi.Waiting)
            }
        }
        Hint("Local failover cooldowns, not provider quota reset times.", icon = null)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Selection(range: String, metric: Metric, onRange: (String) -> Unit, onMetric: (Metric) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            UsageReport.RANGES.forEachIndexed { index, option ->
                SegmentedButton(selected = option == range, onClick = { onRange(option) }, shape = SegmentedButtonDefaults.itemShape(index, UsageReport.RANGES.size)) {
                    Text(RANGE_LABELS.getValue(option))
                }
            }
        }
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            Metric.entries.forEachIndexed { index, option ->
                SegmentedButton(selected = option == metric, onClick = { onMetric(option) }, shape = SegmentedButtonDefaults.itemShape(index, Metric.entries.size)) {
                    Text(if (option == Metric.Cost) "Cost ($)" else "Tokens")
                }
            }
        }
    }
}

@Composable
private fun TotalCard(range: UsageRange, metric: Metric) {
    val series = range.measure(metric).series
    val per = when (range.bucketHours) { 1 -> "hour"; 6 -> "6 hours"; else -> "day" }
    SectionCard(null) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stat("Cost", "$" + cost(range.cost), Modifier.weight(1f), color = if (metric == Metric.Cost) Pi.Accent else Color.Unspecified)
            Stat("Tokens", tokens(range.tokens), Modifier.weight(1f), color = if (metric == Metric.Tokens) Pi.Accent else Color.Unspecified)
            Stat("Cache hit", "${(range.cacheHit * 100).roundToInt()}%", Modifier.weight(1f))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("${if (metric == Metric.Cost) "Cost" else "Tokens"} per $per", Modifier.weight(1f))
            Text("peak ${amount(metric, series.maxOrNull() ?: 0.0)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        BarChart(series, Pi.Accent, Modifier.fillMaxWidth().height(120.dp))
        Row {
            Text(if (range.range == "today") "00:00" else RANGE_LABELS.getValue(range.range) + " ago", style = MaterialTheme.typography.labelSmall, color = Pi.Dim)
            Spacer(Modifier.weight(1f))
            Text("now", style = MaterialTheme.typography.labelSmall, color = Pi.Dim)
        }
    }
}

/** Each machine's share, with the remote hosts whose usage is incomplete marked and explained. */
@Composable
private fun HostsCard(range: UsageRange, metric: Metric, remotes: List<RemoteUsageHost>, gateway: String) {
    val hosts = range.measure(metric).hosts
    val total = range.total(metric)
    SectionCard("${if (metric == Metric.Cost) "Cost" else "Tokens"} by host") {
        hosts.forEach { usage ->
            val gap = remotes.firstOrNull { it.host == usage.host }?.gap
            val share = if (total > 0) usage.value / total else 0.0
            UsageBar(usage.host ?: gateway, "${(share * 100).roundToInt()}% · ${amount(metric, usage.value)}", share, Pi.Accent,
                if (gap == null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant, note = gap, labelLines = 2)
        }
        if (remotes.any { it.gap != null }) Hint("A host that is offline, connecting or still indexing shows what it has reported so far; its totals are incomplete.", icon = null)
    }
}

/** One bar per bucket, oldest at the left, scaled to the largest. */
@Composable
private fun BarChart(values: List<Double>, color: Color, modifier: Modifier = Modifier) {
    val baseline = MaterialTheme.colorScheme.outlineVariant
    Canvas(modifier) {
        drawLine(baseline, Offset(0f, size.height), Offset(size.width, size.height), strokeWidth = 1.dp.toPx())
        val max = values.maxOrNull() ?: 0.0
        if (max <= 0) return@Canvas
        val slot = size.width / values.size
        val gap = (slot * 0.2f).coerceAtMost(3.dp.toPx())
        values.forEachIndexed { index, value ->
            if (value <= 0) return@forEachIndexed
            val height = (value / max * size.height).toFloat().coerceAtLeast(1.dp.toPx())
            drawRoundRect(color, Offset(index * slot + gap / 2, size.height - height), Size(slot - gap, height), CornerRadius(2.dp.toPx()))
        }
    }
}

@Composable
private fun SessionsCard(sessions: List<UsageItem>, metric: Metric, indexing: Boolean) {
    SectionCard("${if (metric == Metric.Cost) "Cost" else "Tokens"} by session") {
        if (sessions.isEmpty()) Hint(if (indexing) "Still indexing." else "No usage in this range.", icon = null)
        else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusDot(Pi.Accent)
            Text("open session", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val max = sessions.firstOrNull()?.value ?: 0.0
        sessions.forEach { session ->
            UsageBar(session.label, amount(metric, session.value), session.value / max, if (session.open) Pi.Accent else Pi.Dim,
                if (session.open) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ModelsCard(range: UsageRange, metric: Metric) {
    val models = range.measure(metric).models
    val total = range.total(metric)
    SectionCard("By model") {
        if (models.isEmpty()) Hint("No usage in this range.", icon = null)
        models.forEach { model ->
            val share = if (total > 0) model.value / total else 0.0
            UsageBar(model.label, "${(share * 100).roundToInt()}% · ${amount(metric, model.value)}", share, Pi.Accent, MaterialTheme.colorScheme.onSurface)
        }
    }
}

/**
 * The label gets only the width the value leaves, so [note] goes under the bar, not in the row, and a label that
 * identifies a machine may take [labelLines] lines: with a large system font a single line holds about six characters.
 */
@Composable
private fun UsageBar(label: String, value: String, fraction: Double, color: Color, labelColor: Color, note: String? = null, labelLines: Int = 1) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = labelColor, maxLines = labelLines, overflow = TextOverflow.Ellipsis)
            Text(value, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Meter(fraction, color)
        if (note != null) Text(note, style = MaterialTheme.typography.bodySmall, color = Pi.Waiting)
    }
}

// Formats as in the terminal dashboard (src/dashboard/ui/format.ts).

private fun amount(metric: Metric, value: Double): String = if (metric == Metric.Cost) "$" + cost(value) else tokens(value)

private fun cost(dollars: Double): String = when {
    dollars >= 100 -> "%.0f"
    dollars >= 10 -> "%.1f"
    else -> "%.2f"
}.format(dollars)

internal fun tokens(count: Double): String {
    for ((unit, suffix) in listOf(1e9 to "B", 1e6 to "M", 1e3 to "k")) {
        if (count < unit) continue
        val value = count / unit
        return (if (value >= 100) "%.0f" else "%.1f").format(value) + suffix
    }
    return count.roundToLong().toString()
}

internal fun duration(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    if (minutes < 10) return "${minutes}m%02ds".format(seconds % 60)
    if (minutes < 60) return "${minutes}m"
    val hours = minutes / 60
    if (hours < 24) return "${hours}h%02dm".format(minutes % 60)
    return "${hours / 24}d${hours % 24}h"
}

internal fun clock(at: Long): String = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("HH:mm"))
