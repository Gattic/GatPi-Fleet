package dev.pidash.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.DashViewModel
import dev.pidash.android.Metric
import dev.pidash.android.Quota
import dev.pidash.android.UsageItem
import dev.pidash.android.UsageRange
import dev.pidash.android.UsageReport
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Colours of a quota window's largest sessions, as in the terminal's usage view. */
private val SHARE_COLORS = listOf(Pi.Accent, Pi.Working, Pi.Waiting, Pi.Violet)
private val RANGE_LABELS = mapOf("today" to "Today", "7d" to "7 days", "30d" to "30 days")

/** The terminal dashboard's usage view: quota windows, then cost or tokens over a range by time, session and model. */
@Composable
internal fun UsageScreen(vm: DashViewModel, fresh: Boolean) {
    val report = vm.usage.collectAsStateWithLifecycle().value
    val range by vm.usageRange.collectAsStateWithLifecycle()
    val metric by vm.usageMetric.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Usage", style = MaterialTheme.typography.headlineSmall)
                    Text(report?.let { "pi's API usage on the host, as of ${clock(it.at)}" } ?: "pi's API usage on the host",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = vm::refreshUsage, enabled = fresh && !busy) { Icon(Icons.Filled.Refresh, "Refresh usage") }
            }
        }
        if (report == null) {
            if (!busy) item { Hint("Usage was not loaded. Refresh to try again.") }
            return@LazyColumn
        }
        if (report.indexing) item { Hint("Indexing the host's session files; totals are still growing.") }
        item { QuotaCard(report) }
        item { Selection(range, metric, onRange = { vm.usageRange.value = it }, onMetric = { vm.usageMetric.value = it }) }
        val selected = report.range(range)
        item { TotalCard(selected, metric) }
        item { SessionsCard(selected.measure(metric).sessions, metric, report.indexing) }
        item { ModelsCard(selected, metric) }
        item {
            Hint("$ is pi's API-equivalent cost, not a subscription invoice; unpriced models count in tokens only. " +
                "Subagents count toward the session that spawned them. Counts the host's own session files and logins " +
                "(not its remote hosts'); 30 days kept.")
        }
    }
}

@Composable
private fun QuotaCard(report: UsageReport) {
    SectionCard("Quota") {
        if (report.quota.isEmpty()) Hint("No subscription quota data on the host.", icon = null)
        report.quota.forEach { QuotaWindow(it, report.at) }
    }
}

@Composable
private fun QuotaWindow(quota: Quota, at: Long) {
    val used = quota.usedPercent / 100
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(quota.provider, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(quota.window, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            quota.resetAt?.let { Text("resets in ${duration(it - at)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text("${quota.usedPercent.roundToInt()}%", style = MaterialTheme.typography.labelLarge, color = levelColor(used))
        }
        Meter(used, levelColor(used))
        quota.exhaustedUntil?.let { Text("Exhausted for ${duration(it - at)}", style = MaterialTheme.typography.bodySmall, color = Pi.Error) }
        if (quota.shares.isNotEmpty()) {
            Text("Share by session (est.)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp))) {
                quota.shares.forEachIndexed { index, share -> Box(Modifier.weight(share.share.toFloat()).fillMaxHeight().background(SHARE_COLORS[index])) }
                val rest = 1 - quota.shares.sumOf { it.share }
                if (rest > 0.001) Box(Modifier.weight(rest.toFloat()).fillMaxHeight().background(Pi.Dim))
            }
            quota.shares.forEachIndexed { index, share ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusDot(SHARE_COLORS[index])
                    Text(share.label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${(share.share * 100).roundToInt()}%", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
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

@Composable
private fun UsageBar(label: String, value: String, fraction: Double, color: Color, labelColor: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = labelColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(value, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Meter(fraction, color)
    }
}

// Formats as in the terminal dashboard (src/dashboard/ui/format.ts).

private fun amount(metric: Metric, value: Double): String = if (metric == Metric.Cost) "$" + cost(value) else tokens(value)

private fun cost(dollars: Double): String = when {
    dollars >= 100 -> "%.0f"
    dollars >= 10 -> "%.1f"
    else -> "%.2f"
}.format(dollars)

private fun tokens(count: Double): String {
    for ((unit, suffix) in listOf(1e9 to "B", 1e6 to "M", 1e3 to "k")) {
        if (count < unit) continue
        val value = count / unit
        return (if (value >= 100) "%.0f" else "%.1f").format(value) + suffix
    }
    return count.roundToLong().toString()
}

private fun duration(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    if (minutes < 10) return "${minutes}m%02ds".format(seconds % 60)
    if (minutes < 60) return "${minutes}m"
    val hours = minutes / 60
    if (hours < 24) return "${hours}h%02dm".format(minutes % 60)
    return "${hours / 24}d${hours % 24}h"
}

private fun clock(at: Long): String = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("HH:mm"))
