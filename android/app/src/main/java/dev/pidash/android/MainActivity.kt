package dev.pidash.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.pidash.g1.G1Diagnostics
import dev.pidash.g1.GlassesState
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private val app get() = application as DashApp
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { DashScreen() } }
    }
    override fun onStart() { super.onStart(); app.repository.foreground(true) }
    override fun onStop() { app.repository.foreground(false); super.onStop() }
}

@Composable
private fun DashScreen(vm: DashViewModel = viewModel()) {
    val state by vm.repository.state.collectAsStateWithLifecycle()
    val pending by vm.repository.pending.collectAsStateWithLifecycle()
    val screen by vm.screen.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val confirmation by vm.confirmation.collectAsStateWithLifecycle()
    BackHandler(screen != "sessions") { vm.screen.value = "sessions"; vm.repository.select(null) }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("pi-dash", style = MaterialTheme.typography.headlineMedium)
            Text(if (state.fresh) "● Host online" else "○ Offline / stale · actions disabled", color = if (state.fresh) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
            Row(Modifier.horizontalScroll(rememberScrollState())) {
                TextButton(onClick = { vm.screen.value = "sessions"; vm.repository.select(null) }) { Text("Sessions") }
                TextButton(onClick = vm::openProjects, enabled = state.fresh) { Text("New / resume") }
                TextButton(onClick = { vm.screen.value = "glasses" }) { Text("Glasses") }
                TextButton(onClick = { vm.screen.value = "settings" }) { Text("Pairing") }
            }
            if (pending != null) {
                Card { Column(Modifier.padding(8.dp)) {
                    Text("Pending / uncertain: ${pending!!.description}")
                    Row {
                        TextButton(onClick = { vm.run { vm.repository.reconcile() } }, enabled = state.fresh && !busy) { Text("Check receipt") }
                        TextButton(onClick = { vm.confirmation.value = Confirmation("Dismiss receipt?", "Inspect the actual session first. Dismissing does not cancel, undo or resend an action.", dismissReceipt = true) }) { Text("Inspected; dismiss") }
                    }
                } }
            }
            Box(Modifier.weight(1f)) {
                when (screen) {
                    "session" -> SessionScreen(vm, state, state.fresh && pending == null && !busy)
                    "projects" -> ProjectScreen(vm, state.fresh && pending == null && !busy)
                    "settings" -> PairingScreen(vm)
                    "glasses" -> GlassesScreen(vm)
                    else -> SessionsScreen(vm, state)
                }
            }
            Text(state.message, style = MaterialTheme.typography.bodySmall)
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }
    confirmation?.let { c -> AlertDialog(onDismissRequest = { vm.confirmation.value = null }, title = { Text(c.title) }, text = { Text(c.description) },
        confirmButton = { TextButton(onClick = vm::confirmed, enabled = c.dismissReceipt || state.fresh) { Text("Confirm") } },
        dismissButton = { TextButton(onClick = { vm.confirmation.value = null }) { Text("Cancel") } }) }
}

@Composable
private fun SessionsScreen(vm: DashViewModel, state: Dashboard) {
    val query by vm.filter.collectAsStateWithLifecycle()
    val attention by vm.attentionOnly.collectAsStateWithLifecycle()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(query, { vm.filter.value = it }, Modifier.fillMaxWidth(), label = { Text("Find session / project") }, singleLine = true)
        Row { Checkbox(attention, { vm.attentionOnly.value = it }); Text("Needs attention only", Modifier.padding(top = 12.dp)) }
        val sessions = state.sessions.filter { (!attention || it.attentionKey != null) && (it.label + " " + it.project).contains(query, ignoreCase = true) }
            .sortedWith(compareBy<Session> { it.attentionKey == null }.thenBy { it.since ?: Long.MAX_VALUE })
        if (sessions.isEmpty()) Text("No matching sessions. Start pi on the host, or check pairing and the bridge.")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(sessions, key = { it.id }) { session ->
                Card(Modifier.fillMaxWidth().clickable { vm.select(session) }) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(session.label, style = MaterialTheme.typography.titleMedium)
                        Text(session.project, style = MaterialTheme.typography.bodySmall)
                        Text(session.statusLabel, color = if (session.attentionKey != null) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.primary)
                        session.plan?.let { Text("${it.complete}/${it.total} · ${it.active}") }
                        Text("CTX ${session.contextPercent?.toInt()?.toString() ?: "—"}% · ${session.model ?: "Model unavailable"}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionScreen(vm: DashViewModel, state: Dashboard, enabled: Boolean) {
    val detail = state.detail
    if (detail == null) { Text("Loading detail, or this session ended/reloaded. Return to Sessions to select its current instance."); return }
    val session = detail.session
    val glasses by vm.app.glassesState.collectAsStateWithLifecycle()
    val monitoring by vm.app.monitoring.collectAsStateWithLifecycle()
    val selection by vm.app.wearSelection.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val ask by vm.ask.collectAsStateWithLifecycle()
    val delivery by vm.delivery.collectAsStateWithLifecycle()
    var name by remember(session.id) { mutableStateOf(session.label) }
    var modelMenu by remember { mutableStateOf(false) }
    val can = { kind: String -> enabled && session.commands.containsKey(kind) && session.commands[kind] == null }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(session.label, style = MaterialTheme.typography.headlineSmall)
        Text(session.project)
        Text("${session.statusLabel} · ${session.model ?: "unknown model"} · thinking ${session.thinking ?: "unknown"}")
        session.commands["prompt"]?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text("Interactive extension dialogs and slash commands still require desktop pi.", style = MaterialTheme.typography.bodySmall)
        session.plan?.let { Text("${it.title}\n${it.complete}/${it.total} complete · ${it.active}") }
        Text("Context ${session.contextPercent?.toInt()?.toString() ?: "—"}%")
        session.metrics?.let { Text("CPU %.0f%% · RAM %.0f MiB · GPU %s".format(it.cpu * 100, it.memory / 1048576, it.gpuMemory?.let { gpu -> "%.0f MiB".format(gpu / 1048576) } ?: "unavailable")) } ?: Text("Resource metrics unavailable")
        Text("Live tokens ${session.tokens?.toLong() ?: "—"} · API-equivalent cost ${session.cost?.let { "$%.4f".format(it) } ?: "—"}")
        SessionGlassesControls(
            state = glasses, running = monitoring, displayingSession = selection.id == session.id,
            replyAvailable = !detail.reply.isNullOrBlank(),
            onPin = { vm.app.display(session.id) },
            onExcerpt = { vm.app.display(session.id, detail.reply) },
            onPage = { vm.app.glasses?.page(it) },
        )
        detail.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text("Latest prompt preview", style = MaterialTheme.typography.titleMedium)
        Text(detail.prompt ?: "No prompt preview")
        Text("Latest reply (bounded; not a full transcript)", style = MaterialTheme.typography.titleMedium)
        SelectionContainer { Text(detail.reply ?: "No completed reply", fontFamily = FontFamily.Monospace) }
        detail.suggestion?.let { suggestion -> OutlinedButton(onClick = { vm.draft(suggestion) }) { Text("Edit suggested prompt") } }
        OutlinedTextField(draft, vm::draft, Modifier.fillMaxWidth(), label = { Text("Prompt / unsent draft") }, minLines = 3, maxLines = 8)
        if (session.status in listOf("working", "stalled", "rate-limited")) {
            Row {
                RadioButton(delivery == "steer", { vm.delivery.value = "steer" }); Text("Steer", Modifier.padding(top = 12.dp))
                RadioButton(delivery == "followUp", { vm.delivery.value = "followUp" }); Text("Follow-up", Modifier.padding(top = 12.dp))
            }
        }
        Button(onClick = { vm.prompt(session) }, enabled = can("prompt") && draft.isNotBlank()) { Text("Send prompt") }
        Text("Side question — uses the session model; billed separately; does not alter its conversation", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(ask, { vm.ask.value = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Ask about this session") })
        Button(onClick = { vm.ask(session) }, enabled = can("ask") && ask.isNotBlank()) { Text("Ask") }
        detail.asks.forEach { a ->
            Text("${a.status}: ${a.question}", style = MaterialTheme.typography.titleSmall)
            SelectionContainer { Text(a.error ?: a.answer) }
            a.cost?.let { Text("Side-question cost $%.4f".format(it)) }
        }
        Text("Recent tools", style = MaterialTheme.typography.titleMedium)
        detail.tools.asReversed().forEach { Text("${it.name} · ${it.detail} · ${if (it.running) "running" else if (it.failed) "failed" else "finished"}") }
        HorizontalDivider()
        OutlinedTextField(name, { name = it.take(120) }, label = { Text("Session name") })
        OutlinedButton(onClick = { vm.run { vm.repository.command(session, JSONObject().put("kind", "rename").put("name", name)) } }, enabled = can("rename") && name.isNotBlank()) { Text("Rename") }
        Box {
            OutlinedButton(onClick = { modelMenu = true }, enabled = can("model")) { Text("Choose model") }
            DropdownMenu(modelMenu, { modelMenu = false }) { detail.models.forEach { model ->
                DropdownMenuItem(text = { Text(model) }, onClick = {
                    modelMenu = false
                    val slash = model.indexOf('/')
                    if (slash > 0) vm.run { vm.repository.command(session, JSONObject().put("kind", "model").put("provider", model.take(slash)).put("id", model.substring(slash + 1))) }
                })
            } }
        }
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            listOf("off", "minimal", "low", "medium", "high", "xhigh", "max").forEach { level ->
                TextButton(onClick = { vm.run { vm.repository.command(session, JSONObject().put("kind", "thinking").put("level", level)) } }, enabled = can("thinking")) { Text(level) }
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            listOf("abort", "compact", "shutdown").forEach { kind ->
                OutlinedButton(onClick = { vm.confirm(session, kind) }, enabled = can(kind)) { Text(if (kind == "shutdown") "Close gracefully" else kind) }
                Spacer(Modifier.width(6.dp))
            }
        }
    }
}

@Composable
private fun ProjectScreen(vm: DashViewModel, enabled: Boolean) {
    val projects by vm.projects.collectAsStateWithLifecycle()
    val project by vm.project.collectAsStateWithLifecycle()
    val history by vm.history.collectAsStateWithLifecycle()
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Approved projects", style = MaterialTheme.typography.titleLarge) }
        if (projects.isEmpty()) item { Text("No approved projects. Add projectRoots to the gateway configuration on the host.") }
        items(projects, key = { it.id }) { p ->
            Card { Column(Modifier.fillMaxWidth().padding(8.dp)) {
                Text(p.path)
                Row {
                    TextButton(onClick = { vm.confirmLaunch(p, null) }, enabled = enabled) { Text("New") }
                    TextButton(onClick = { vm.history(p) }, enabled = enabled) { Text("History") }
                }
            } }
        }
        project?.let { p ->
            item { Text("Resume in ${p.label}", style = MaterialTheme.typography.titleLarge) }
            items(history, key = { it.id }) { h -> Card { Column(Modifier.fillMaxWidth().padding(8.dp)) {
                Text(h.title)
                h.blocked?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                TextButton(onClick = { vm.confirmLaunch(p, h) }, enabled = enabled && h.blocked == null) { Text("Resume") }
            } } }
        }
    }
}

@Composable
private fun PairingScreen(vm: DashViewModel) {
    var document by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf<Pairing?>(null) }
    var checked by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Secure local pairing", style = MaterialTheme.typography.titleLarge)
        Text(vm.repository.host() ?: "No host paired")
        Text("On your host run pi-dash-server pair --name PHONE. Paste its sensitive JSON here. Verify the certificate fingerprint against the host before trusting it. No cloud relay is used.")
        OutlinedTextField(document, { document = it.take(16_000); preview = null; checked = false }, label = { Text("Pairing JSON") }, modifier = Modifier.fillMaxWidth(), minLines = 3, maxLines = 6)
        OutlinedButton(onClick = { try { preview = Pairing.parse(document) } catch (e: Exception) { vm.repository.message(e.message ?: "Invalid pairing") } }) { Text("Inspect certificate") }
        preview?.let { p ->
            Text(p.url)
            SelectionContainer { Text("SHA-256\n${p.fingerprint}", fontFamily = FontFamily.Monospace) }
            Row { Checkbox(checked, { checked = it }); Text("Fingerprint matches the host", Modifier.padding(top = 12.dp)) }
            Button(onClick = { vm.run { vm.repository.pair(document); vm.resetDrafts(); document = ""; preview = null; checked = false; vm.screen.value = "sessions" } }, enabled = checked) { Text("Trust and pair") }
        }
        Text("Pairing grants the phone your host user's pi session privileges. Prompts can cause file changes and command execution. Revoke lost devices on the host.")
        OutlinedButton(onClick = {
            context.stopService(Intent(context, GlassesService::class.java))
            vm.repository.logout(); vm.resetDrafts(); document = ""; preview = null
        }) { Text("Disconnect and erase local credentials/drafts") }
        Text("This APK targets Android 12+. Phone-only background alerts are not promised. Open the app to refresh, or explicitly start glasses monitoring.")
    }
}

@Composable
private fun GlassesScreen(vm: DashViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val app = vm.app
    val glasses by app.glassesState.collectAsStateWithLifecycle()
    val running by app.monitoring.collectAsStateWithLifecycle()
    val alerts by app.attentionAlerts.collectAsStateWithLifecycle()
    val permissions = remember { buildList {
        add(Manifest.permission.BLUETOOTH_SCAN); add(Manifest.permission.BLUETOOTH_CONNECT)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }.toTypedArray() }
    fun start() {
        app.glassesState.value = GlassesState(session = "Starting glasses monitoring…")
        try { ContextCompat.startForegroundService(context, Intent(context, GlassesService::class.java)) }
        catch (_: SecurityException) { app.glassesState.value = GlassesState(error = "Allow Nearby devices and notifications, then tap Connect again.") }
        catch (_: IllegalStateException) { app.glassesState.value = GlassesState(error = "Keep pi-dash open and tap Connect to start glasses monitoring.") }
    }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        if (permissions.all { grants[it] == true || ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }) start()
        else app.glassesState.value = GlassesState(error = "Allow Nearby devices and notifications to connect. The phone dashboard still works without them.")
    }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        GlassesConnectionControls(
            state = glasses, running = running, paired = vm.repository.host() != null,
            onConnect = {
                app.glassesState.value = GlassesState(session = "Requesting Bluetooth and notification permissions…")
                request.launch(permissions)
            },
            onDisconnect = { context.stopService(Intent(context, GlassesService::class.java)) },
            onChoosePair = { app.glasses?.selectPair(it) },
        )
        GlassesPagingControls(glasses, running) { app.glasses?.page(it) }
        Row {
            TextButton(onClick = { app.display() }) { Text("Overview") }
            TextButton(onClick = { app.glasses?.hide() }, enabled = running) { Text("Hide") }
        }
        Row { Checkbox(alerts, app::alerts); Text("Attention alerts (names/status only)", Modifier.padding(top = 12.dp)) }
        Text("Pin sessions or show reply excerpts from session detail. Paging is on this phone; single taps are not supported. Double-tap dismissal and Silent Mode suppress automatic redisplay. Triple taps toggle Silent Mode. Glasses gestures never approve actions.")
        Text("Monitoring uses a foreground service and bounded wake lock while your phone is locked. It stops after 12 hours, force-stop or reboot. Battery usage must be measured on your phone. Stop here before returning to the Even app.")
        Text("Connection diagnostics (metadata only)", style = MaterialTheme.typography.titleMedium)
        Text(G1Diagnostics.snapshot(), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
    }
}
