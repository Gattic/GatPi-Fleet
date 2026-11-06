package dev.pidash.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pidash.android.Background
import dev.pidash.android.Dashboard
import dev.pidash.android.DashViewModel
import dev.pidash.android.Session

private data class JobItem(val session: Session, val work: Background)

/** All background work of running sessions, with the command or task each job was given. */
@Composable
internal fun JobsScreen(vm: DashViewModel, state: Dashboard) {
    val jobs = state.sessions.flatMap { session ->
        session.metrics?.background.orEmpty().map { JobItem(session, it) }
    }.sortedWith(compareBy<JobItem> { it.session.label }.thenBy { it.work.startedAt })
    val jobCount = jobs.count { it.work.kind == "job" }
    val subagentCount = jobs.size - jobCount
    val sessions = jobs.map { it.session.id }.distinct().size
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Background work", style = MaterialTheme.typography.headlineSmall)
                Text(
                    if (jobs.isEmpty()) "Background work from running sessions"
                    else buildString {
                        val kinds = listOfNotNull(
                            jobCount.takeIf { it > 0 }?.let { "$it ${if (it == 1) "job" else "jobs"}" },
                            subagentCount.takeIf { it > 0 }?.let { "$it ${if (it == 1) "subagent" else "subagents"}" },
                        )
                        append(kinds.joinToString(" · "))
                        append(" across $sessions ${if (sessions == 1) "session" else "sessions"}")
                    },
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        when {
            state.updatedAt == 0L -> item { Loading("Loading background work…") }
            jobs.isEmpty() -> item {
                SectionCard(null) {
                    Text("No background jobs", style = MaterialTheme.typography.titleMedium)
                    Hint("bg_run jobs and subagents appear here while they run.", icon = null)
                }
            }
            else -> {
                item { Hint("Ages and usage are from the host's last update. Tap a job to open its session.") }
                itemsIndexed(jobs, key = { index, job -> "${job.session.id}:${job.work.kind}:${job.work.label}:${job.work.startedAt}:$index" }) { _, job ->
                    JobCard(job, state.updatedAt) { vm.select(job.session) }
                }
            }
        }
    }
}

@Composable
private fun JobCard(job: JobItem, now: Long, onClick: () -> Unit) {
    val work = job.work
    val color = if (work.kind == "job") Pi.Working else Pi.Violet
    Card(
        onClick = onClick, modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Surface(shape = CircleShape, color = color.copy(alpha = 0.14f), contentColor = color) {
                    Text(if (work.kind == "job") "JOB" else "SUBAGENT", Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        style = MaterialTheme.typography.labelSmall)
                }
                Text(work.label, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(duration((now - work.startedAt).coerceAtLeast(0)), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("${job.session.label} · ${job.session.project}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (work.detail != null) {
                Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
                    SelectionContainer {
                        Text(work.detail, Modifier.padding(10.dp), fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall, maxLines = 6, overflow = TextOverflow.Ellipsis)
                    }
                }
            } else {
                Text("No command or task recorded", style = MaterialTheme.typography.bodySmall, color = Pi.Dim)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Stat("CPU", "%.0f%%".format(work.cpu * 100), Modifier.weight(1f))
                Stat("RAM", mib(work.memory), Modifier.weight(1f))
                Stat("Session", job.session.statusLabel, Modifier.weight(1f))
            }
        }
    }
}
