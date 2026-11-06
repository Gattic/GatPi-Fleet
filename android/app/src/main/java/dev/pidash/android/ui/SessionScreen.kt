package dev.pidash.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.Ask
import dev.pidash.android.Dashboard
import dev.pidash.android.DashViewModel
import dev.pidash.android.Detail
import dev.pidash.android.Session
import dev.pidash.android.Tool
import org.json.JSONObject

private val thinkingLevels = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

@Composable
internal fun SessionScreen(vm: DashViewModel, state: Dashboard, enabled: Boolean) {
    val detail = state.detail
    if (detail == null) {
        EmptyState("Loading session detail…", "Waiting for this session's detail. If the session is no longer available, the app returns to Sessions.") {
            CircularProgressIndicator(Modifier.size(32.dp))
        }
        return
    }
    val session = detail.session
    // A command is available when the host lists it with no reason it is blocked.
    val can = { kind: String -> enabled && session.commands.containsKey(kind) && session.commands[kind] == null }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OverviewCard(session, can("dismiss")) { vm.dismiss(session) }
        ContextBreakdownCard(detail.context)
        RoadmapCard(session.id, detail.roadmap, session.plan != null, session.plan?.active,
            state.fresh && !state.detailStale && session.connected && session.status != "exited")
        GitCard(vm, session, state.fresh, enabled, can("prompt"))
        detail.error?.let { Notice(it, Pi.Error) }
        ExchangeCard(detail)
        PromptCard(vm, session, detail.suggestion, detail.prompts, can("prompt"), can("suggest"))
        SessionGlassesCard(vm, detail)
        SideQuestionCard(vm, session, detail.asks, can("ask"))
        ToolsCard(detail.tools)
        ManageCard(vm, session, detail.models, can)
    }
}

@Composable
private fun OverviewCard(session: Session, canDismiss: Boolean, onDismiss: () -> Unit) {
    SectionCard(null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatusPill(session.status, session.statusLabel)
            Text("${session.model ?: "unknown model"} · thinking ${session.thinking ?: "unknown"}", Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        session.commands["prompt"]?.let { Notice(it, Pi.Error) }
        // Offered once the session has exited; dismissing it in pi-dash removes it here too.
        if ("dismiss" in session.commands && session.commands["dismiss"] == null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Hint("Dismiss removes it from the session list, here and in pi-dash.", Modifier.weight(1f))
                FilledTonalButton(onClick = onDismiss, enabled = canDismiss) { Text("Dismiss") }
            }
        }
        session.plan?.let { plan ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(plan.title, style = MaterialTheme.typography.titleSmall)
                PlanProgress(plan)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row {
                Text("Context", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                ContextLabel(session.contextPercent)
            }
            session.contextPercent?.let { Meter(it / 100, levelColor(it / 100)) }
        }
        val metrics = session.metrics
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stat("CPU", metrics?.let { "%.0f%%".format(it.cpu * 100) }, Modifier.weight(1f))
            Stat("RAM", metrics?.let { mib(it.memory) }, Modifier.weight(1f))
            Stat("GPU", metrics?.gpuMemory?.let(::mib), Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stat("Live tokens", session.tokens?.let { "%,d".format(it.toLong()) }, Modifier.weight(1f))
            Stat("API-equivalent cost", session.cost?.let { "$%.4f".format(it) }, Modifier.weight(2f))
        }
    }
}

internal fun mib(bytes: Double) = "%.0f MiB".format(bytes / 1048576)

@Composable
private fun ExchangeCard(detail: Detail) {
    SectionCard("Latest exchange") {
        Text("Prompt", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(detail.prompt ?: "No prompt preview", style = MaterialTheme.typography.bodyMedium)
        Text("Reply (bounded; not a full transcript)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
            SelectionContainer {
                Text(detail.reply ?: "No completed reply", Modifier.padding(12.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PromptCard(vm: DashViewModel, session: Session, suggestion: String?, prompts: List<String>, enabled: Boolean, canSuggest: Boolean) {
    val drafts = vm.drafts
    val draft by drafts.text.collectAsStateWithLifecycle()
    val recall by drafts.recall.collectAsStateWithLifecycle()
    val delivery by vm.delivery.collectAsStateWithLifecycle()
    // The field keeps its own value, so the cursor follows typing. Text the app puts in it (a recalled prompt,
    // the suggestion, the session's saved draft) replaces that value with the cursor at its end.
    var field by remember { mutableStateOf(TextFieldValue(drafts.text.value, TextRange(drafts.text.value.length))) }
    LaunchedEffect(drafts) { drafts.text.collect { text -> if (text != field.text) field = TextFieldValue(text, TextRange(text.length)) } }
    SectionCard("Prompt") {
        FilledTonalButton(onClick = { vm.suggest(session) }, enabled = canSuggest) { Text("New prompt suggestion") }
        Hint("Requests a fresh suggestion from pi; it may use the configured advisory model. Review it before sending.")
        suggestion?.let {
            OutlinedButton(onClick = { drafts.edit(it) }) {
                Icon(Icons.Filled.Edit, null, Modifier.size(ButtonDefaults.IconSize)); Spacer(Modifier.width(ButtonDefaults.IconSpacing)); Text("Edit suggested prompt")
            }
        }
        // The arrows step through the session's earlier prompts, as ↑ and ↓ do in pi's editor.
        OutlinedTextField(field, { next -> field = next; if (next.text != drafts.text.value) drafts.edit(next.text) }, Modifier.fillMaxWidth(), label = { Text("Prompt / unsent draft") }, minLines = 3, maxLines = 8,
            trailingIcon = {
                Column {
                    IconButton(onClick = { drafts.older(prompts) }, enabled = recall.canOlder(prompts)) { Icon(Icons.Filled.KeyboardArrowUp, "Older prompt") }
                    IconButton(onClick = { drafts.newer(prompts) }, enabled = recall.canNewer) { Icon(Icons.Filled.KeyboardArrowDown, "Newer prompt") }
                }
            },
            supportingText = recall.position?.let { { Text("Earlier prompt ${it + 1} of ${prompts.size}") } })
        if (session.running) {
            val options = listOf("steer" to "Steer", "followUp" to "Follow-up")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                options.forEachIndexed { index, (value, label) ->
                    SegmentedButton(delivery == value, { vm.delivery.value = value }, SegmentedButtonDefaults.itemShape(index, options.size)) { Text(label) }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Hint("Interactive extension dialogs and slash commands still require desktop pi.", Modifier.weight(1f))
            Button(onClick = { vm.prompt(session) }, enabled = enabled && draft.isNotBlank()) {
                Icon(Icons.AutoMirrored.Filled.Send, null, Modifier.size(ButtonDefaults.IconSize)); Spacer(Modifier.width(ButtonDefaults.IconSpacing)); Text("Send prompt")
            }
        }
    }
}

@Composable
private fun SessionGlassesCard(vm: DashViewModel, detail: Detail) {
    val glasses by vm.app.glassesState.collectAsStateWithLifecycle()
    val monitoring by vm.app.monitoring.collectAsStateWithLifecycle()
    val selection by vm.app.wearSelection.collectAsStateWithLifecycle()
    val id = detail.session.id
    SectionCard("Glasses") {
        SessionGlassesControls(
            state = glasses, running = monitoring, displayingSession = selection.id == id,
            replyAvailable = !detail.reply.isNullOrBlank(),
            onPin = { vm.app.display(id) },
            onExcerpt = { vm.app.display(id, detail.reply) },
            onPage = { vm.app.glasses?.page(it) },
        )
    }
}

@Composable
private fun SideQuestionCard(vm: DashViewModel, session: Session, asks: List<Ask>, enabled: Boolean) {
    val ask by vm.ask.collectAsStateWithLifecycle()
    SectionCard("Side question") {
        Hint("Uses the session model; billed separately; does not alter its conversation.")
        OutlinedTextField(ask, { vm.ask.value = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text("Ask about this session") })
        FilledTonalButton(onClick = { vm.ask(session) }, enabled = enabled && ask.isNotBlank(), modifier = Modifier.align(Alignment.End)) { Text("Ask") }
        asks.forEach { AskItem(it) }
    }
}

@Composable
private fun AskItem(ask: Ask) {
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(ask.question, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                Text(ask.status, style = MaterialTheme.typography.labelSmall, color = if (ask.error != null) Pi.Error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            SelectionContainer { Text(ask.error ?: ask.answer, style = MaterialTheme.typography.bodyMedium, color = if (ask.error != null) Pi.Error else MaterialTheme.colorScheme.onSurface) }
            ask.cost?.let { Text("Side-question cost $%.4f".format(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@Composable
private fun ToolsCard(tools: List<Tool>) {
    SectionCard("Recent tools") {
        if (tools.isEmpty()) Text("No recent tools", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        tools.asReversed().forEach { tool ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.padding(top = 2.dp).size(16.dp), contentAlignment = Alignment.Center) {
                    when {
                        tool.running -> CircularProgressIndicator(Modifier.size(12.dp), color = Pi.Working, strokeWidth = 2.dp)
                        tool.failed -> Icon(Icons.Filled.Close, "failed", Modifier.size(16.dp), tint = Pi.Error)
                        else -> Icon(Icons.Filled.Check, "finished", Modifier.size(16.dp), tint = Pi.Dim)
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(tool.name, style = MaterialTheme.typography.labelLarge, fontFamily = FontFamily.Monospace)
                    if (tool.detail.isNotBlank()) Text(tool.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ManageCard(vm: DashViewModel, session: Session, models: List<String>, can: (String) -> Boolean) {
    var name by remember(session.id) { mutableStateOf(session.label) }
    fun command(kind: String, build: JSONObject.() -> Unit = {}) = vm.run { vm.repository.command(session, JSONObject().put("kind", kind).apply(build)) }
    SectionCard("Manage session") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(name, { name = it.take(120) }, Modifier.weight(1f), label = { Text("Session name") }, singleLine = true)
            FilledTonalButton(onClick = { command("rename") { put("name", name) } }, enabled = can("rename") && name.isNotBlank()) { Text("Rename") }
        }
        Text("Model", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        ModelSelector(session.id, session.model, models, can("model")) { model ->
            val slash = model.indexOf('/')
            if (slash > 0) command("model") { put("provider", model.take(slash)); put("id", model.substring(slash + 1)) }
        }
        Text("Thinking", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            thinkingLevels.forEach { level ->
                FilterChip(selected = session.thinking == level, onClick = { command("thinking") { put("level", level) } }, enabled = can("thinking"), label = { Text(level) })
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Text("Run control", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val danger = ButtonDefaults.outlinedButtonColors(contentColor = Pi.Error)
            listOf("abort" to "Abort", "compact" to "Compact", "reload" to "Reload", "restart" to "Restart", "shutdown" to "Close gracefully").forEach { (kind, label) ->
                val destructive = kind in listOf("abort", "restart", "shutdown")
                OutlinedButton(
                    onClick = { vm.confirm(session, kind) }, enabled = can(kind),
                    colors = if (destructive) danger else ButtonDefaults.outlinedButtonColors(),
                    border = if (destructive && can(kind)) BorderStroke(1.dp, Pi.Error.copy(alpha = 0.6f)) else ButtonDefaults.outlinedButtonBorder(can(kind)),
                ) { Text(label) }
            }
        }
    }
}
