package dev.pidash.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.Dashboard
import dev.pidash.android.DashViewModel
import dev.pidash.android.Screen
import dev.pidash.android.Session

@Composable
internal fun SessionsScreen(vm: DashViewModel, state: Dashboard) {
    val query by vm.filter.collectAsStateWithLifecycle()
    val attention by vm.attentionOnly.collectAsStateWithLifecycle()
    val needing = state.sessions.count { it.attentionKey != null }
    val working = state.sessions.count { it.status == "working" }
    val jobs = state.sessions.sumOf { it.metrics?.background?.size ?: 0 }
    // Sessions needing you come first, longest waiting at the top.
    val sessions = state.sessions.filter { (!attention || it.attentionKey != null) && (it.label + " " + it.project).contains(query, ignoreCase = true) }
        .sortedWith(compareBy<Session> { it.attentionKey == null }.thenBy { it.since ?: Long.MAX_VALUE })
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(
                query, { vm.filter.value = it }, Modifier.fillMaxWidth(), label = { Text("Find session / project") }, singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, null) },
                trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { vm.filter.value = "" }) { Icon(Icons.Filled.Clear, "Clear search") } },
                shape = CircleShape,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = attention, onClick = { vm.attentionOnly.value = !attention },
                    label = { Text("Needs attention · $needing") },
                    leadingIcon = if (attention) { { Icon(Icons.Filled.Check, null, Modifier.size(FilterChipDefaults.IconSize)) } } else null,
                )
                AssistChip(onClick = { vm.screen.value = Screen.Jobs }, label = { Text("Jobs · $jobs") })
                Text("${state.sessions.size} sessions · $working working", Modifier.weight(1f), textAlign = TextAlign.End,
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        when {
            // Before the first snapshot there is no overview to filter; say so instead of
            // claiming there are no sessions.
            state.updatedAt == 0L -> Loading("Loading sessions…", Modifier.padding(horizontal = 16.dp))
            sessions.isEmpty() -> EmptyState("No matching sessions", "Start pi on the host, or check pairing and the bridge.")
            else -> LazyColumn(contentPadding = PaddingValues(start = 16.dp, top = 4.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(sessions, key = { it.id }) { session -> SessionCard(session, state.updatedAt) { vm.select(session) } }
            }
        }
    }
}

@Composable
private fun SessionCard(session: Session, now: Long, onClick: () -> Unit) {
    val attention = session.attentionKey != null
    val surface = MaterialTheme.colorScheme.surfaceContainer
    Card(
        onClick = onClick, modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = if (attention) Pi.Waiting.copy(alpha = 0.08f).compositeOver(surface) else surface),
        border = if (attention) BorderStroke(1.dp, Pi.Waiting.copy(alpha = 0.5f)) else null,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(session.label, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(session.project, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                StatusPill(session.status, session.statusLabel)
            }
            session.plan?.let { PlanProgress(it) }
            session.metrics?.background?.takeIf { it.isNotEmpty() }?.let { work ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("BG", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        work.joinToString(" · ") { "${it.kind} ${it.label} ${duration((now - it.startedAt).coerceAtLeast(0))}" },
                        Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(session.model ?: "Model unavailable", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                ContextLabel(session.contextPercent)
            }
        }
    }
}
