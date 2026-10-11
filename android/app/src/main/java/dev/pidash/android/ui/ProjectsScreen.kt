package dev.pidash.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.DashViewModel
import dev.pidash.android.History
import dev.pidash.android.Project

@Composable
internal fun ProjectsScreen(vm: DashViewModel, enabled: Boolean) {
    val choices = vm.projects.collectAsStateWithLifecycle().value
    val expanded by vm.project.collectAsStateWithLifecycle()
    val history by vm.history.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    // In order: the gateway's own machine (null), then its remote hosts.
    val byHost = choices?.projects.orEmpty().groupBy { it.host }
    val remotes = byHost.keys.any { it != null } || !choices?.unreachable.isNullOrEmpty()
    val gateway = vm.repository.host()?.removePrefix("https://") ?: "Gateway host"
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Projects", style = MaterialTheme.typography.headlineSmall)
                Text("Start a new pi session or resume a previous one on a host.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        when {
            choices == null -> if (!busy) item { Hint("Projects were not loaded. Tap Projects to try again.") }
            choices.projects.isEmpty() -> item { Hint("No projects yet. Projects appear once pi has run in them on a host.") }
        }
        byHost.forEach { (host, projects) ->
            if (remotes) item(key = "host:$host") { SectionLabel(host ?: gateway) }
            items(projects, key = { it.id }) { project ->
                val open = expanded == project
                ProjectCard(
                    project, open, history.takeIf { open }, loading = open && busy, enabled = enabled,
                    onNew = { vm.confirmLaunch(project, null) }, onHistory = { vm.history(project) }, onResume = { vm.confirmLaunch(project, it) },
                )
            }
        }
        items(choices?.unreachable.orEmpty(), key = { "unreachable:${it.host}" }) { Notice("${it.host}: ${it.error}", Pi.Error) }
    }
}

@Composable
private fun ProjectCard(
    project: Project, open: Boolean, history: List<History>?, loading: Boolean, enabled: Boolean,
    onNew: () -> Unit, onHistory: () -> Unit, onResume: (History) -> Unit,
) {
    SectionCard(null) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(project.label, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(project.path, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = onNew, enabled = enabled) {
                Icon(Icons.Filled.Add, null, Modifier.size(ButtonDefaults.IconSize)); Spacer(Modifier.width(ButtonDefaults.IconSpacing)); Text("New")
            }
            OutlinedButton(onClick = onHistory, enabled = enabled) {
                Text("History"); Spacer(Modifier.width(ButtonDefaults.IconSpacing))
                Icon(if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, null, Modifier.size(ButtonDefaults.IconSize))
            }
        }
        if (history != null) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            SectionLabel("Resume in ${project.label}")
            if (history.isEmpty() && !loading) Text("No resumable sessions found.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            history.forEach { h ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f).padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(h.title, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        h.blocked?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Pi.Error) }
                    }
                    TextButton(onClick = { onResume(h) }, enabled = enabled && h.blocked == null) { Text("Resume") }
                }
            }
        }
    }
}
