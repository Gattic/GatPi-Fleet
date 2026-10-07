package dev.pidash.android

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            OutlinedButton(onClick = onPin) { Text("Pin on G1") }
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = onExcerpt, enabled = replyAvailable) { Text("Reply excerpt on G1") }
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
            Text("G1 display", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (state.page > 0) "Page ${state.page} / ${state.pageCount}" else "No page", maxLines = 1, softWrap = false)
            // Normal ACK waits change only this fixed-size slot, never the wrapping connection text.
            Box(Modifier.size(24.dp).clearAndSetSemantics { contentDescription = description }, contentAlignment = Alignment.Center) {
                when (status) {
                    DisplayStatus.PENDING -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    DisplayStatus.ACKNOWLEDGED -> Text("✓", color = MaterialTheme.colorScheme.primary)
                    DisplayStatus.FAILED -> Text("!", color = MaterialTheme.colorScheme.error)
                    DisplayStatus.IDLE -> Text("—")
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { onPage(-1) }, enabled = available && state.page > 1, modifier = Modifier.weight(1f)) { Text("Previous") }
            TextButton(onClick = { onPage(1) }, enabled = available && state.page < state.pageCount, modifier = Modifier.weight(1f)) { Text("Next") }
        }
        // Suppression/failure remains readable; pending and acknowledged have identical geometry.
        Text(message, style = MaterialTheme.typography.bodySmall, minLines = 2,
            color = if (status == DisplayStatus.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
