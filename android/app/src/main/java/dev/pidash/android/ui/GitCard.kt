package dev.pidash.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.DashViewModel
import dev.pidash.android.GitView
import dev.pidash.android.Session

@Composable
internal fun GitCard(vm: DashViewModel, session: Session, fresh: Boolean, enabled: Boolean, canPrompt: Boolean) {
    val view by vm.git.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val state by vm.repository.state.collectAsStateWithLifecycle()
    val current = view?.takeIf { it.sessionId == session.id }
    GitControls(current, canRead = fresh && !busy, canAct = enabled && current?.menu?.epoch == state.epoch, canPrompt = canPrompt,
        onRefresh = { vm.openGit(session) }, onClose = vm::closeGit,
        onAction = { kind -> if (kind == "switch") vm.gitBranches(session) else vm.confirmGit(session, kind) },
        onBranch = { vm.confirmGit(session, "switch", it) }, onStatus = { vm.gitStatus(session) }, onCommit = { vm.gitCommitPrompt(session) })
}

/** Read-only inspection stays available while a mutation's receipt is pending. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GitControls(
    view: GitView?, canRead: Boolean, canAct: Boolean, canPrompt: Boolean,
    onRefresh: () -> Unit, onClose: () -> Unit, onAction: (String) -> Unit,
    onBranch: (String) -> Unit, onStatus: () -> Unit, onCommit: () -> Unit,
) {
    SectionCard("Git") {
        if (view == null) {
            OutlinedButton(onClick = onRefresh, enabled = canRead) { Text("Open git menu") }
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onRefresh, enabled = canRead) { Text("Refresh git") }
                TextButton(onClick = onClose) { Text("Close git menu") }
            }
            view.error?.let { Notice(it, Pi.Error) }
            val menu = view.menu
            if (menu == null && view.error == null) Hint("Checking git…")
            menu?.let {
                Text(menu.head + (menu.upstream?.let { " → $it" } ?: " · no upstream"), style = MaterialTheme.typography.titleSmall)
                Text(menu.location, style = MaterialTheme.typography.bodySmall)
                Text("Tree: ${menu.tree}")
                if (menu.upstream != null) Text("${menu.ahead} ahead · ${menu.behind} behind")
                Hint("Ahead/behind uses the host's current remote-tracking refs; Refresh does not fetch.")
                if (menu.warning.isNotBlank()) Notice(menu.warning.trim(), Pi.Waiting)
                menu.actions.forEach { action ->
                    FilledTonalButton(onClick = { onAction(action.kind) }, enabled = canAct && action.blocked == null) { Text(action.label) }
                    action.blocked?.let { Hint(it) }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onStatus, enabled = canRead) { Text("View status") }
                    OutlinedButton(onClick = onCommit, enabled = canAct && canPrompt) { Text("Ask AI to review/commit") }
                }
                Hint("Review/commit opens an editable prompt; it does not send or push automatically.")
            }
            view.branches?.let { branches ->
                Text("Local branches", style = MaterialTheme.typography.titleSmall)
                if (branches.isEmpty()) Hint("No local branches found")
                Column(Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState())) {
                    branches.forEach { branch ->
                        TextButton(onClick = { onBranch(branch.name) }, enabled = canAct && !branch.current) {
                            Text(branch.name + (if (branch.current) " · current" else "") + (branch.upstream?.let { " · tracks $it" } ?: ""))
                        }
                    }
                }
            }
            view.status?.let { status ->
                Text("git status", style = MaterialTheme.typography.titleSmall)
                SelectionContainer {
                    Text(status, Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
