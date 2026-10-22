package dev.pidash.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.pidash.android.Roadmap
import dev.pidash.android.RoadmapEntry

/** Viewer state belongs to the selected incarnation; no command, prompt or network mutation is exposed. */
@Composable
internal fun RoadmapCard(sessionId: String, roadmap: Roadmap?, hasPlan: Boolean, active: String?, fresh: Boolean) {
    var open by rememberSaveable(sessionId) { mutableStateOf(false) }
    SectionCard("Roadmap") {
        Text(roadmap?.title ?: if (hasPlan) "Roadmap detail unavailable" else "No roadmap published")
        FilledTonalButton(onClick = { open = true }) { Text("Open roadmap") }
    }
    if (open) RoadmapDialog(roadmap, hasPlan, active, fresh) { open = false }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoadmapDialog(roadmap: Roadmap?, hasPlan: Boolean, active: String?, fresh: Boolean, onClose: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), dragHandle = null) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth()) {
                    Text("Roadmap Viewer", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = onClose) { Text("Close") }
                }
                if (!fresh) Notice("Last known roadmap · connection stale, session disconnected or exited", Pi.Waiting)
                else Hint("Live roadmap · read-only")
                LazyColumn(Modifier.weight(1f).testTag("roadmap-entries"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (roadmap == null) {
                        item {
                            Text(if (hasPlan) "Nested roadmap detail unavailable. Update GatPi-Harness and /reload the session." else "No roadmap published for this session.")
                        }
                    } else {
                        item {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(roadmap.title, style = MaterialTheme.typography.titleMedium)
                                Text("Lifecycle: ${roadmap.lifecycle}")
                                Text("Root outcomes: ${roadmap.outcomesComplete}/${roadmap.outcomesTotal} complete · ${roadmap.outcomesBlocked} blocked")
                                Text("Workflow: ${roadmap.complete}/${roadmap.total} complete · ${roadmap.blocked} blocked")
                                Hint("Updated: ${roadmap.updatedAt}")
                                if (!active.isNullOrBlank()) Text("Active: $active")
                                if (roadmap.limited) Notice("Showing first ${roadmap.entries.size} of ${roadmap.totalEntries} entries (snapshot limit).", Pi.Waiting)
                                if (roadmap.totalEntries == 0) Text("No roadmap items yet.")
                            }
                        }
                        items(roadmap.entries, key = { "${it.kind}:${it.path}" }) { entry -> RoadmapRow(entry) }
                    }
                }
            }
        }
    }
}

@Composable
private fun RoadmapRow(entry: RoadmapEntry) {
    Surface(Modifier.fillMaxWidth().padding(start = (entry.depth.coerceAtMost(6) * 8).dp),
        shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        SelectionContainer {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val color = when (entry.status) {
                    "active" -> Pi.Accent
                    "done", "verified" -> Pi.Working
                    "blocked", "verified-unsubstantiated" -> Pi.Waiting
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
                Text("${entry.label} · ${entry.status}", style = MaterialTheme.typography.labelMedium, color = color)
                Text(entry.title, style = MaterialTheme.typography.bodyMedium)
                entry.notes.forEach { Text("Note: $it", style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
