package dev.pidash.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pidash.g1.DisplayStatus
import dev.pidash.g1.GlassesState

/** Both surfaces control the same display, without navigating away from session detail. */
@Composable
internal fun SessionGlassesControls(
    state: GlassesState, running: Boolean, displayingSession: Boolean, replyAvailable: Boolean,
    onPin: () -> Unit, onExcerpt: () -> Unit, onPage: (Int) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // Equal-height halves, even when the longer label wraps.
        Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = onPin, modifier = Modifier.weight(1f).fillMaxHeight()) { Text("Pin on G1") }
            FilledTonalButton(onClick = onExcerpt, enabled = replyAvailable, modifier = Modifier.weight(1f).fillMaxHeight()) { Text("Reply excerpt on G1") }
        }
        if (displayingSession) GlassesPagingControls(state, running, onPage)
    }
}

@Composable
internal fun GlassesPagingControls(state: GlassesState, running: Boolean, onPage: (Int) -> Unit) {
    val available = running && state.page > 0 && !state.silent && !state.dismissed &&
        state.left == "ready" && state.right == "ready"
    val status = if (available) state.displayStatus else DisplayStatus.IDLE
    val description = when (status) {
        DisplayStatus.IDLE -> "Display inactive"
        DisplayStatus.PENDING -> "Awaiting display acknowledgment"
        DisplayStatus.ACKNOWLEDGED -> "Display acknowledged"
        DisplayStatus.FAILED -> "Display not acknowledged"
    }
    val message = when {
        !running -> "Glasses monitoring stopped"
        state.silent -> "Silent Mode: display suppressed"
        state.dismissed -> "Dismissed: select Overview or a session display to show it again"
        state.page == 0 -> "No page selected"
        !available -> "Waiting for glasses"
        status == DisplayStatus.FAILED -> "Display not acknowledged. Previous text may remain."
        else -> ""
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("G1 display", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (state.page > 0) "Page ${state.page} / ${state.pageCount}" else "No page", style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false)
            // Normal ACK waits change only this fixed-size slot, never the wrapping connection text.
            Box(Modifier.size(24.dp).clearAndSetSemantics { contentDescription = description }, contentAlignment = Alignment.Center) {
                when (status) {
                    DisplayStatus.PENDING -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    DisplayStatus.ACKNOWLEDGED -> Text("✓", color = Pi.Working)
                    DisplayStatus.FAILED -> Text("!", color = Pi.Error)
                    DisplayStatus.IDLE -> Text("—", color = Pi.Dim)
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { onPage(-1) }, enabled = available && state.page > 1, modifier = Modifier.weight(1f), contentPadding = ButtonDefaults.TextButtonContentPadding) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, null, Modifier.size(ButtonDefaults.IconSize)); Text("Previous")
            }
            OutlinedButton(onClick = { onPage(1) }, enabled = available && state.page < state.pageCount, modifier = Modifier.weight(1f), contentPadding = ButtonDefaults.TextButtonContentPadding) {
                Text("Next"); Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(ButtonDefaults.IconSize))
            }
        }
        // Suppression/failure remains readable; pending and acknowledged have identical geometry.
        Text(message, style = MaterialTheme.typography.bodySmall, minLines = 2,
            color = if (status == DisplayStatus.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
