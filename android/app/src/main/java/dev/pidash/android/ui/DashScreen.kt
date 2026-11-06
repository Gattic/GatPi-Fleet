package dev.pidash.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.vectorResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.pidash.android.Confirmation
import dev.pidash.android.DashViewModel
import dev.pidash.android.Pending
import dev.pidash.android.R
import dev.pidash.android.Screen
import dev.pidash.android.Session

/** App shell: top bar, gateway status line, pending-receipt banner, current screen and navigation. */
@Composable
fun DashScreen(vm: DashViewModel = viewModel()) {
    val state by vm.repository.state.collectAsStateWithLifecycle()
    val pending by vm.repository.pending.collectAsStateWithLifecycle()
    val screen by vm.screen.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val confirmation by vm.confirmation.collectAsStateWithLifecycle()
    val actionsEnabled = state.fresh && pending == null && !busy
    // Not observable itself; pairing, erasing and each connection attempt change the state above, so re-read it here.
    val host = vm.repository.host()
    BackHandler(screen != Screen.Sessions, vm::back)
    Scaffold(
        topBar = {
            when (screen) {
                Screen.Session -> SessionTopBar(state.detail?.session ?: state.sessions.firstOrNull { it.id == state.selected }, state.fresh, vm::back)
                Screen.Jobs -> SimpleTopBar("Jobs", "Background work from running sessions", vm::back)
                else -> DashTopBar(host, state.fresh)
            }
        },
        bottomBar = { if (screen != Screen.Session && screen != Screen.Jobs) DashNavigation(screen, state.fresh, vm) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            StatusLine(state.message, busy)
            pending?.let { p ->
                PendingBanner(
                    p, canCheck = state.fresh && !busy,
                    onCheck = { vm.run { vm.repository.reconcile() } },
                    onDismiss = { vm.confirmation.value = Confirmation("Dismiss receipt?", "Inspect the actual session first. Dismissing does not cancel, undo or resend an action.", dismissReceipt = true) },
                )
            }
            Box(Modifier.weight(1f)) {
                when (screen) {
                    Screen.Sessions -> SessionsScreen(vm, state)
                    Screen.Session -> SessionScreen(vm, state, actionsEnabled)
                    Screen.Jobs -> JobsScreen(vm, state)
                    Screen.Projects -> ProjectsScreen(vm, actionsEnabled)
                    Screen.Usage -> UsageScreen(vm, state.fresh)
                    Screen.Context -> ContextScreen(vm, state.fresh)
                    Screen.Glasses -> GlassesScreen(vm)
                    Screen.Pairing -> PairingScreen(vm, host)
                }
            }
        }
    }
    confirmation?.let { ConfirmationDialog(it, canConfirm = it.dismissReceipt || (state.fresh && (it.git == null || (actionsEnabled && it.git.menu.epoch == state.epoch && it.git.session.id == state.selected))), onConfirm = vm::confirmed, onCancel = { vm.confirmation.value = null }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DashTopBar(host: String?, fresh: Boolean) {
    TopAppBar(
        title = {
            Column {
                Text("pi-dash", style = MaterialTheme.typography.titleLarge, color = Pi.Violet)
                Text(host?.removePrefix("https://") ?: "No host paired", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        },
        actions = { ConnectionChip(fresh, Modifier.padding(end = 12.dp)) },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionTopBar(session: Session?, fresh: Boolean, onBack: () -> Unit) {
    TopAppBar(
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to sessions") } },
        title = {
            Column {
                Text(session?.label ?: "Session", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                session?.let { Text(it.project, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        },
        actions = { ConnectionChip(fresh, Modifier.padding(end = 12.dp)) },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SimpleTopBar(title: String, subtitle: String, onBack: () -> Unit) {
    TopAppBar(
        navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back to sessions") } },
        title = {
            Column {
                Text(title, style = MaterialTheme.typography.titleLarge)
                Text(subtitle, style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
    )
}

@Composable
private fun ConnectionChip(fresh: Boolean, modifier: Modifier = Modifier) {
    val color = if (fresh) Pi.Working else Pi.Error
    Surface(modifier, shape = CircleShape, color = color.copy(alpha = 0.14f), contentColor = color) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusDot(color)
            Text(if (fresh) "Online" else "Offline", style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** The gateway's latest message, with a fixed-height slot for progress so content never jumps. */
@Composable
private fun StatusLine(message: String, busy: Boolean) {
    Column {
        Text(message, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Box(Modifier.fillMaxWidth().height(2.dp)) { if (busy) LinearProgressIndicator(Modifier.fillMaxSize()) }
    }
}

@Composable
private fun PendingBanner(pending: Pending, canCheck: Boolean, onCheck: () -> Unit, onDismiss: () -> Unit) {
    Surface(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer) {
        Column(Modifier.padding(start = 16.dp, top = 12.dp, end = 8.dp, bottom = 4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Filled.Warning, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.tertiary)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Pending / uncertain action", style = MaterialTheme.typography.titleSmall)
                    Text(pending.description, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onCheck, enabled = canCheck) { Text("Check receipt") }
                TextButton(onClick = onDismiss) { Text("Inspected; dismiss") }
            }
        }
    }
}

private class Destination(val screen: Screen, val label: String, val icon: ImageVector)

@Composable
private fun DashNavigation(screen: Screen, fresh: Boolean, vm: DashViewModel) {
    val destinations = listOf(
        Destination(Screen.Sessions, "Sessions", Icons.AutoMirrored.Filled.List),
        Destination(Screen.Projects, "Projects", ImageVector.vectorResource(R.drawable.ic_folder)),
        Destination(Screen.Usage, "Usage", ImageVector.vectorResource(R.drawable.ic_usage)),
        Destination(Screen.Context, "Context", ImageVector.vectorResource(R.drawable.ic_context)),
        Destination(Screen.Glasses, "Glasses", ImageVector.vectorResource(R.drawable.ic_glasses)),
        Destination(Screen.Pairing, "Pairing", Icons.Filled.Lock),
    )
    NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        for (destination in destinations) {
            // Project choices, usage and context are fetched from the host, so they need a live connection.
            val fetched = destination.screen in listOf(Screen.Projects, Screen.Usage, Screen.Context)
            NavigationBarItem(
                selected = screen == destination.screen,
                onClick = {
                    when (destination.screen) {
                        Screen.Projects -> vm.openProjects()
                        Screen.Usage -> vm.openUsage()
                        Screen.Context -> vm.openContext()
                        else -> vm.screen.value = destination.screen
                    }
                },
                enabled = fresh || !fetched,
                icon = { Icon(destination.icon, null) }, label = { Text(destination.label) },
                colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.primaryContainer),
            )
        }
    }
}

@Composable
private fun ConfirmationDialog(confirmation: Confirmation, canConfirm: Boolean, onConfirm: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        icon = { Icon(Icons.Filled.Warning, null, tint = MaterialTheme.colorScheme.tertiary) },
        title = { Text(confirmation.title) },
        text = { Text(confirmation.description) },
        confirmButton = { TextButton(onClick = onConfirm, enabled = canConfirm) { Text("Confirm") } },
        dismissButton = { OutlinedButton(onClick = onCancel) { Text("Cancel") } },
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    )
}
