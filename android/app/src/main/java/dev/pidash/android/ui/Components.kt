package dev.pidash.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.pidash.android.Plan

@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    Box(modifier.size(size).background(color, CircleShape))
}

/** A session status as the host labels it, coloured by its kind. */
@Composable
fun StatusPill(kind: String, label: String, modifier: Modifier = Modifier) {
    val color = statusColor(kind)
    Surface(modifier, shape = CircleShape, color = color.copy(alpha = 0.14f), contentColor = color) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusDot(color)
            Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A titled group of related content; screens are stacks of these. */
@Composable
fun SectionCard(title: String?, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (title != null) SectionLabel(title)
            content()
        }
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
}

/** Secondary explanation: caveats and guidance that should not compete with the content. */
@Composable
fun Hint(text: String, modifier: Modifier = Modifier, icon: ImageVector? = Icons.Filled.Info) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (icon != null) Icon(icon, null, Modifier.padding(top = 1.dp).size(16.dp), tint = Pi.Dim)
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A warning or failure the operator must read; tinted with [color]. */
@Composable
fun Notice(text: String, color: Color, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = color.copy(alpha = 0.12f), contentColor = color) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Filled.Warning, null, Modifier.size(18.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** A labelled value; unknown values are shown as a dash, never as zero. */
@Composable
fun Stat(label: String, value: String?, modifier: Modifier = Modifier, color: Color = Color.Unspecified) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        Text(value ?: "—", style = MaterialTheme.typography.titleMedium, color = if (value == null) Pi.Dim else color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun Meter(fraction: Double, color: Color, modifier: Modifier = Modifier) {
    LinearProgressIndicator(
        progress = { fraction.toFloat().coerceIn(0f, 1f) }, modifier = modifier.fillMaxWidth().height(6.dp),
        color = color, trackColor = MaterialTheme.colorScheme.surfaceContainerHighest, strokeCap = StrokeCap.Round,
        gapSize = 0.dp, drawStopIndicator = {},
    )
}

@Composable
fun PlanProgress(plan: Plan, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(plan.active.ifBlank { plan.title }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${plan.complete}/${plan.total}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Meter(if (plan.total > 0) plan.complete.toDouble() / plan.total else 0.0, Pi.Violet)
    }
}

/** Context-window use, coloured like the terminal's CTX column. */
@Composable
fun ContextLabel(percent: Double?) {
    Text("CTX ${percent?.toInt()?.let { "$it%" } ?: "—"}", style = MaterialTheme.typography.labelMedium,
        color = percent?.let { levelColor(it / 100) } ?: Pi.Dim)
}

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier, icon: @Composable (() -> Unit)? = null) {
    Column(modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        icon?.invoke()
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}
