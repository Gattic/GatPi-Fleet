package dev.pidash.android.ui

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
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.ContextBreakdown
import dev.pidash.android.ContextParts
import dev.pidash.android.ContextReport
import dev.pidash.android.ContextRow
import dev.pidash.android.ContextScopeReport
import dev.pidash.android.CumulativeContext
import dev.pidash.android.DashViewModel
import dev.pidash.android.SessionContext
import kotlin.math.abs
import kotlin.math.roundToInt

private val SCOPE_LABELS = mapOf("open" to "Open", "today" to "Today", "30d" to "30 days")

private class ContextPart(val label: String, val color: Color, val value: (ContextParts) -> Double)

/** Fixed category order, as in the terminal dashboard. */
private val CONTEXT_PARTS = listOf(
    ContextPart("system", Pi.Dim) { it.system },
    ContextPart("tools", Pi.Accent) { it.tools },
    ContextPart("injected", Pi.Waiting) { it.injected },
    ContextPart("user", Pi.Working) { it.user },
    ContextPart("assistant", Pi.Violet) { it.assistant },
    ContextPart("tool results", Color(0xFF7FA6B8)) { it.toolResults },
    ContextPart("summary", Pi.Muted) { it.summary },
)

/** The phone's context tab: per-session measured totals, estimated composition and cumulative scopes. */
@Composable
internal fun ContextScreen(vm: DashViewModel, fresh: Boolean) {
    val report by vm.context.collectAsStateWithLifecycle()
    val scope by vm.contextScope.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Context", style = MaterialTheme.typography.headlineSmall)
                    Text(report?.let { "pi's measured context on the host${if (it.scopes.any { s -> s.rows.any { r -> r.host != null } }) " and its remote hosts" else ""}, as of ${clock(it.at)}" } ?: "pi's measured context on the host",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = vm::refreshContext, enabled = fresh && !busy) { Icon(Icons.Filled.Refresh, "Refresh context") }
            }
        }
        if (report == null) {
            item { if (busy) Loading("Loading context…") else Hint("Context was not loaded. Refresh to try again.") }
            return@LazyColumn
        }
        val loaded = report!!
        item { ScopeSelection(scope, onScope = { vm.contextScope.value = it }) }
        val selected = loaded.scope(scope)
        item { CumulativeCard(selected.cumulative, scope, selected.rows.size) }
        if (selected.cumulative.hosts.isNotEmpty()) item { HostsCard(selected.cumulative) }
        if (selected.cumulative.models.isNotEmpty()) item { ModelsCard(selected.cumulative) }
        item { RowsCard(selected) }
        item {
            Hint("The total is pi's measured context; parts are estimates from characters/4, not a token count. " +
                "Unknown stays unknown, never zero; unattributed is measured context the estimate did not place. " +
                "No prompt or transcript text leaves the host. 30 days kept; ended sessions fill only.")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScopeSelection(scope: String, onScope: (String) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        ContextReport.SCOPES.forEachIndexed { index, option ->
            SegmentedButton(selected = option == scope, onClick = { onScope(option) }, shape = SegmentedButtonDefaults.itemShape(index, ContextReport.SCOPES.size)) {
                Text(SCOPE_LABELS.getValue(option))
            }
        }
    }
}

@Composable
private fun CumulativeCard(cumulative: CumulativeContext, scope: String, sessions: Int) {
    val fill = if (cumulative.fillWindows > 0) (cumulative.fillTokens / cumulative.fillWindows * 100).roundToInt() else null
    SectionCard("Cumulative composition") {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stat("Σ measured", tokens(cumulative.compositionTokens), Modifier.weight(1f))
            Stat("Fill", fill?.let { "$it%" }, Modifier.weight(1f))
            Stat("Sessions", sessions.toString(), Modifier.weight(1f))
        }
        if (fill == null) Hint("Fill unknown: no session in this scope has a known window.", icon = null)
        else Text("Weighted mean fill across ${tokens(cumulative.fillWindows)} window tokens.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val denominator = cumulative.compositionTokens.takeIf { it > 0 } ?: (cumulative.parts.total + (cumulative.unattributed?.coerceAtLeast(0.0) ?: 0.0))
        ContextComposition(cumulative.parts, cumulative.unattributed, denominator, cumulative.compositionTokens)
        Text("${cumulative.near} ≥ 80% · ${cumulative.unknown} unknown · ${cumulative.unbridged} unbridged", style = MaterialTheme.typography.bodySmall,
            color = if (cumulative.near > 0) Pi.Waiting else MaterialTheme.colorScheme.onSurfaceVariant)
        if (scope != "open") Text("Ended (fill only) ${tokens(cumulative.endedTokens)} over ${cumulative.endedSessions} sessions.", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (cumulative.imageBlocks > 0) Text("${cumulative.imageBlocks} image block${if (cumulative.imageBlocks == 1) "" else "s"} included in the categories above.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ContextComposition(parts: ContextParts, unattributed: Double?, denominator: Double, compositionTokens: Double?) {
    if (parts.total <= 0 && (unattributed ?: 0.0) <= 0) {
        Meter(0.0, Pi.Dim)
        Hint("No projected parts.", icon = null)
        return
    }
    val residual = (unattributed ?: 0.0).coerceAtLeast(0.0)
    ContextStackedBar(parts, residual, denominator)
    Spacer(Modifier.height(8.dp))
    ContextLegend(parts, unattributed, compositionTokens)
}

@Composable
private fun ContextLegend(parts: ContextParts, unattributed: Double?, compositionTokens: Double?) {
    val total = parts.total
    if (total <= 0) Hint("No projected parts.", icon = null)
    CONTEXT_PARTS.filter { it.value(parts) > 0 }.forEach { part ->
        val value = part.value(parts)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(10.dp).background(part.color, RoundedCornerShape(2.dp)))
            Text(part.label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("${percentOf(value, total) ?: 0}% · ${tokens(value)}", style = MaterialTheme.typography.labelSmall)
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(10.dp).background(MaterialTheme.colorScheme.outline, RoundedCornerShape(2.dp)))
        Text("unattributed", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val percent = compositionTokens?.takeIf { it > 0 }?.let { percentOf(unattributed ?: 0.0, it) }
        Text(unattributed?.let { signedTokens(it) + (percent?.let { p -> " ($p%)" } ?: "") } ?: "unknown", style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun RowsCard(selected: ContextScopeReport) {
    SectionCard("By session (${selected.rows.size})") {
        if (selected.rows.isEmpty()) {
            Hint(if (selected.scope == "open") "No open sessions." else "No sessions in this scope.", icon = null)
            return@SectionCard
        }
        selected.rows.forEach { row -> ContextRowItem(row) }
    }
}

@Composable
private fun ContextRowItem(row: ContextRow) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(row.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(row.tokens?.let(::tokens) ?: "—", style = MaterialTheme.typography.labelMedium, color = if (row.tokens == null) Pi.Dim else MaterialTheme.colorScheme.onSurface)
        }
        val breakdown = row.breakdown
        when {
            breakdown != null -> {
                val residual = (breakdown.unattributed ?: 0.0).coerceAtLeast(0.0)
                val denominator = row.window ?: (breakdown.parts.total + residual)
                ContextStackedBar(breakdown.parts, residual, denominator, height = 6.dp)
            }
            row.percent != null -> Meter(row.percent / 100, levelColor(row.percent / 100))
        }
        val fill = row.percent?.let { "${it.roundToInt()}%" } ?: "—"
        val marks = buildList {
            if (row.unbridged) add("no bridge") else if (row.tokens == null) add("unknown")
            if (row.tokens != null && breakdown == null) add("no breakdown")
            if (!row.live) add("ended")
            if (row.compactAt != null) add("compact at ${tokens(row.compactAt)}")
        }
        val details = listOfNotNull(
            row.host ?: "this machine",
            row.model,
            "window ${row.window?.let(::tokens) ?: "—"}",
            "fill $fill",
        ).joinToString(" · ")
        Text(details, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (marks.isNotEmpty()) Text(marks.joinToString(" · "), style = MaterialTheme.typography.labelSmall,
            color = if (row.percent != null && row.percent > 100) Pi.Error else if (marks.any { it == "no bridge" || it == "unknown" || it == "no breakdown" }) Pi.Waiting else Pi.Dim)
    }
}

@Composable
private fun HostsCard(cumulative: CumulativeContext) {
    val total = cumulative.hosts.sumOf { it.tokens }
    SectionCard("By host") {
        cumulative.hosts.forEach { host ->
            val share = if (total > 0) host.tokens / total else 0.0
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(host.host ?: "this machine", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Text("${(share * 100).roundToInt()}% · ${tokens(host.tokens)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Meter(share, Pi.Accent)
            }
        }
    }
}

@Composable
private fun ModelsCard(cumulative: CumulativeContext) {
    val total = cumulative.models.sumOf { it.tokens }
    SectionCard("By model") {
        cumulative.models.forEach { model ->
            val share = if (total > 0) model.tokens / total else 0.0
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(model.model, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${(share * 100).roundToInt()}% · ${tokens(model.tokens)} · ${model.sessions} session${if (model.sessions == 1) "" else "s"}",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Meter(share, Pi.Violet)
            }
        }
    }
}

/** A session's measured context and estimated composition, shown in session detail. */
@Composable
internal fun ContextBreakdownCard(context: SessionContext?) {
    if (context == null) return
    SectionCard("Context breakdown") {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stat("Measured", context.tokens?.let(::tokens), Modifier.weight(1f))
            Stat("Window", context.window?.let(::tokens), Modifier.weight(1f))
            Stat("Fill", context.percent?.let { "${it.roundToInt()}%" }, Modifier.weight(1f))
        }
        val breakdown: ContextBreakdown? = context.breakdown
        if (context.tokens == null) {
            Hint("Unknown — the host has not measured this session's context.", icon = null)
        }
        if (breakdown == null) {
            Hint("No composition estimate from this host's bridge.", icon = null)
            return@SectionCard
        }
        val residual = (breakdown.unattributed ?: 0.0).coerceAtLeast(0.0)
        val denominator = context.window ?: context.tokens ?: (breakdown.parts.total + residual)
        ContextComposition(breakdown.parts, breakdown.unattributed, denominator, context.tokens)
        if (breakdown.counts.imageBlocks > 0) Text("${breakdown.counts.imageBlocks} image block${if (breakdown.counts.imageBlocks == 1) "" else "s"} included in the categories above.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Hint("Total is measured; parts are estimated from characters/4. Compact at ${breakdown.compactAt?.let(::tokens) ?: "unknown"}. No prompt or transcript text is sent to this device.", icon = null)
    }
}

@Composable
private fun ContextStackedBar(parts: ContextParts, residual: Double, denominator: Double, height: Dp = 10.dp) {
    val segments = CONTEXT_PARTS.mapNotNull { part -> part.value(parts).takeIf { it > 0 }?.let { it to part.color } }
    val used = segments.sumOf { it.first } + residual
    val track = MaterialTheme.colorScheme.surfaceContainerHighest
    val shape = RoundedCornerShape(5.dp)
    if (used <= 0) {
        Box(Modifier.fillMaxWidth().height(height).clip(shape).background(track))
        return
    }
    Row(Modifier.fillMaxWidth().height(height).clip(shape).background(track)) {
        segments.forEach { (value, color) -> Box(Modifier.weight(value.toFloat()).fillMaxHeight().background(color)) }
        if (residual > 0) Box(Modifier.weight(residual.toFloat()).fillMaxHeight().background(MaterialTheme.colorScheme.outline))
        val rest = (denominator - used).coerceAtLeast(0.0)
        if (rest > 0) Box(Modifier.weight(rest.toFloat()).fillMaxHeight().background(track))
    }
}

private fun percentOf(value: Double, total: Double): Int? = if (total > 0) (value / total * 100).roundToInt() else null

private fun signedTokens(value: Double): String = (if (value < 0) "−" else "+") + tokens(abs(value))
