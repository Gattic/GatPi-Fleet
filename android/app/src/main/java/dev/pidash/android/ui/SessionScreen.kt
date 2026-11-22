package dev.pidash.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.Ask
import dev.pidash.android.Dashboard
import dev.pidash.android.DashViewModel
import dev.pidash.android.Detail
import dev.pidash.android.Drafts
import dev.pidash.android.PromptRecall
import dev.pidash.android.Session
import dev.pidash.android.capitalizeSentences
import org.json.JSONObject

private val thinkingLevels = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

/** Session detail is split by what the user is doing: talking to pi, asking aside, watching it work, or changing it. */
private enum class SessionTab(val label: String) { Chat("Chat"), Ask("Ask"), Activity("Activity"), Manage("Manage") }

@OptIn(ExperimentalMaterial3Api::class)
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
    var tab by rememberSaveable(session.id) { mutableStateOf(SessionTab.Chat) }
    // Set when a git review puts its prompt in the draft; Chat scrolls to the composer once, then clears it.
    var revealComposer by remember { mutableStateOf(false) }
    // Each tab keeps its scroll position and expanded rows while another tab is shown.
    val tabs = rememberSaveableStateHolder()
    Column(Modifier.fillMaxSize()) {
        SessionHeader(session, can("dismiss")) { vm.dismiss(session) }
        PrimaryTabRow(selectedTabIndex = tab.ordinal) {
            SessionTab.entries.forEach { entry ->
                Tab(selected = tab == entry, onClick = { tab = entry }, text = { Text(entry.label, maxLines = 1) },
                    selectedContentColor = MaterialTheme.colorScheme.primary, unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Box(Modifier.weight(1f)) {
            tabs.SaveableStateProvider(tab.name) {
                when (tab) {
                    SessionTab.Chat -> ChatTab(vm, detail, can, revealComposer) { revealComposer = false }
                    SessionTab.Ask -> TabPage { SideQuestionCard(vm, session, detail.asks, can("ask")) }
                    SessionTab.Activity -> TabPage {
                        RoadmapCard(session.id, detail.roadmap, session.plan != null, session.plan?.active,
                            state.fresh && !state.detailStale && session.connected && session.status != "exited")
                        ToolsCard(detail.tools)
                        ContextBreakdownCard(detail.context)
                        ResourcesCard(session)
                    }
                    SessionTab.Manage -> ManageTab(vm, state, detail, enabled, can) {
                        if (vm.gitCommitPrompt(session)) { revealComposer = true; tab = SessionTab.Chat }
                    }
                }
            }
        }
    }
}

/** What is true of the session whichever tab is open: state, model, context, plan progress and why it cannot be prompted. */
@Composable
private fun SessionHeader(session: Session, canDismiss: Boolean, onDismiss: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatusPill(session.status, session.statusLabel)
            Text("${session.model ?: "unknown model"} · thinking ${session.thinking ?: "unknown"}", Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            ContextLabel(session.contextPercent)
        }
        session.plan?.let { PlanProgress(it) }
        session.commands["prompt"]?.let { Notice(it, Pi.Error) }
        // Offered once the session has exited; dismissing it in pi-dash removes it here too.
        if ("dismiss" in session.commands && session.commands["dismiss"] == null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Hint("Dismiss removes it from the session list, here and in pi-dash.", Modifier.weight(1f))
                FilledTonalButton(onClick = onDismiss, enabled = canDismiss) { Text("Dismiss") }
            }
        }
    }
}

/** One tab's scrollable stack of cards. */
@Composable
private fun TabPage(scroll: ScrollState = rememberScrollState(), content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

/** The latest exchange, then the composer for the next prompt. */
@Composable
private fun ChatTab(vm: DashViewModel, detail: Detail, can: (String) -> Boolean, revealComposer: Boolean, onRevealed: () -> Unit) {
    val scroll = rememberScrollState()
    LaunchedEffect(revealComposer) {
        if (!revealComposer) return@LaunchedEffect
        // The tab has just been composed; its scroll range is known after the first layout. The composer is last.
        withFrameNanos { }
        scroll.animateScrollTo(scroll.maxValue)
        onRevealed()
    }
    TabPage(scroll) {
        detail.error?.let { Notice(it, Pi.Error) }
        ExchangeCard(detail)
        PromptCard(vm, detail.session, detail.suggestion, detail.prompts, can("prompt"), can("suggest"))
    }
}

/** Process resources and usage; unknown values are shown as unknown, never zero. */
@Composable
private fun ResourcesCard(session: Session) {
    val metrics = session.metrics
    SectionCard("Resources") {
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
    val capitalize by vm.app.sentenceCapitalization.collectAsStateWithLifecycle()
    var maximized by rememberSaveable { mutableStateOf(false) }
    var direction by rememberSaveable(session.id) { mutableStateOf("") }
    var directionOpen by rememberSaveable(session.id) { mutableStateOf(false) }
    // Typing capitalizes sentence starts when the option is on. Only letter case changes, so the cursor stays put.
    val edit: (TextFieldValue) -> Unit = { next ->
        field = if (capitalize) next.capitalized() else next
        if (field.text != drafts.text.value) drafts.edit(field.text)
    }
    SectionCard("Prompt", action = { TextButton(onClick = { maximized = true }) { Text("Maximize prompt") } }) {
        suggestion?.let { SuggestedPrompt(it) { drafts.edit(it) } }
        if (session.running) DeliveryChoice(delivery) { vm.delivery.value = it }
        // The arrows step through the session's earlier prompts, as ↑ and ↓ do in pi's editor.
        PromptField(field, edit, prompts, drafts, recall, capitalize, tag = "prompt-field")
        CapitalizeToggle(capitalize, vm.app::setSentenceCapitalization, Modifier.fillMaxWidth())
        if (directionOpen) DirectionField(direction) { direction = it }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { vm.suggest(session, direction) }, enabled = canSuggest) { Text("Suggest") }
            TextButton(onClick = { directionOpen = !directionOpen }) { Text(if (directionOpen) "Hide direction" else "Direction") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.weight(1f))
            SendButton(enabled && draft.isNotBlank()) { vm.prompt(session) }
        }
    }
    if (maximized) ModalBottomSheet(
        onDismissRequest = { maximized = false },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        dragHandle = null,
    ) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Prompt", style = MaterialTheme.typography.titleLarge)
                        Text(session.label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(onClick = { maximized = false }) { Text("Close") }
                }
                PromptField(field, edit, prompts, drafts, recall, capitalize, Modifier.weight(1f), maxLines = Int.MAX_VALUE, autofocus = true, tag = "prompt-maximized")
                if (session.running) DeliveryChoice(delivery) { vm.delivery.value = it }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CapitalizeToggle(capitalize, vm.app::setSentenceCapitalization, Modifier.weight(1f))
                    SendButton(enabled && draft.isNotBlank(), Modifier.testTag("prompt-send-maximized")) { vm.prompt(session); maximized = false }
                }
            }
        }
    }
}

/** The direction that shapes the next suggestion; it is never sent as a prompt. */
@Composable
private fun DirectionField(value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth().testTag("suggestion-direction"),
        label = { Text("Direction for the next suggestion") },
        placeholder = { Text("Your input, opinions or constraints") },
        supportingText = { Text("Shapes the next suggestion; it is never sent as a prompt.") },
        maxLines = 4,
    )
}

/** pi's latest suggestion, shown for reading; only the button copies it into the draft, which is never sent by itself. */
@Composable
private fun SuggestedPrompt(text: String, onEdit: () -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.padding(start = 12.dp, top = 12.dp, end = 4.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Suggested by pi", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text, Modifier.padding(end = 8.dp), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            TextButton(onClick = onEdit, modifier = Modifier.align(Alignment.End)) {
                Icon(Icons.Filled.Edit, null, Modifier.size(ButtonDefaults.IconSize)); Spacer(Modifier.width(ButtonDefaults.IconSpacing)); Text("Edit suggested prompt")
            }
        }
    }
}

/** The sentence-capitalization option; an app setting, so both editors show the same switch. */
@Composable
private fun CapitalizeToggle(capitalize: Boolean, onChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.toggleable(capitalize, role = Role.Switch, onValueChange = onChange), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Capitalize sentences", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
        Switch(capitalize, null)
    }
}

@Composable
private fun SendButton(enabled: Boolean, modifier: Modifier = Modifier, onSend: () -> Unit) {
    Button(onClick = onSend, enabled = enabled, modifier = modifier) {
        Icon(Icons.AutoMirrored.Filled.Send, null, Modifier.size(ButtonDefaults.IconSize)); Spacer(Modifier.width(ButtonDefaults.IconSpacing)); Text("Send prompt")
    }
}

/** The prompt editor, in the card or maximized: same field, recall arrows and keyboard hints. */
@Composable
private fun PromptField(
    field: TextFieldValue,
    onEdit: (TextFieldValue) -> Unit,
    prompts: List<String>,
    drafts: Drafts,
    recall: PromptRecall,
    capitalize: Boolean,
    modifier: Modifier = Modifier,
    maxLines: Int = 8,
    autofocus: Boolean = false,
    tag: String? = null,
) {
    val focus = remember { FocusRequester() }
    if (autofocus) LaunchedEffect(Unit) { focus.requestFocus() }
    OutlinedTextField(field, onEdit,
        modifier.fillMaxWidth()
            .then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .then(if (autofocus) Modifier.focusRequester(focus) else Modifier),
        label = { Text("Prompt / unsent draft") }, minLines = 3, maxLines = maxLines,
        keyboardOptions = KeyboardOptions(capitalization = if (capitalize) KeyboardCapitalization.Sentences else KeyboardCapitalization.None),
        trailingIcon = {
            Column {
                IconButton(onClick = { drafts.older(prompts) }, enabled = recall.canOlder(prompts)) { Icon(Icons.Filled.KeyboardArrowUp, "Older prompt") }
                IconButton(onClick = { drafts.newer(prompts) }, enabled = recall.canNewer) { Icon(Icons.Filled.KeyboardArrowDown, "Newer prompt") }
            }
        },
        supportingText = { Text(recall.position?.let { "Earlier prompt ${it + 1} of ${prompts.size}" } ?: "Slash commands and dialogs need desktop pi.") })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeliveryChoice(delivery: String, modifier: Modifier = Modifier, onDelivery: (String) -> Unit) {
    val options = listOf("steer" to "Steer", "followUp" to "Follow-up")
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(delivery == value, { onDelivery(value) }, SegmentedButtonDefaults.itemShape(index, options.size)) { Text(label) }
        }
    }
}

/** The same value with sentence capitalization applied; only letter case changes, so selection and composing ranges stay valid. */
private fun TextFieldValue.capitalized(): TextFieldValue {
    val capitalized = capitalizeSentences(text)
    return if (capitalized == text) this else copy(text = capitalized)
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

/** Changing the session: run control first, then its model, git, glasses display and name. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ManageTab(vm: DashViewModel, state: Dashboard, detail: Detail, enabled: Boolean, can: (String) -> Boolean, onReviewCommit: () -> Unit) {
    val session = detail.session
    var name by remember(session.id) { mutableStateOf(session.label) }
    fun command(kind: String, build: JSONObject.() -> Unit = {}) = vm.run { vm.repository.command(session, JSONObject().put("kind", kind).apply(build)) }
    TabPage {
        SectionCard("Run control") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val danger = ButtonDefaults.outlinedButtonColors(contentColor = Pi.Error)
                listOf("abort" to "Abort", "compact" to "Compact", "reload" to "Reload", "new" to "New session", "restart" to "Restart", "shutdown" to "Close gracefully").forEach { (kind, label) ->
                    val destructive = kind in listOf("abort", "restart", "shutdown")
                    OutlinedButton(
                        onClick = { vm.confirm(session, kind) }, enabled = can(kind),
                        colors = if (destructive) danger else ButtonDefaults.outlinedButtonColors(),
                        border = if (destructive && can(kind)) BorderStroke(1.dp, Pi.Error.copy(alpha = 0.6f)) else ButtonDefaults.outlinedButtonBorder(can(kind)),
                    ) { Text(label) }
                }
            }
        }
        SectionCard("Model") {
            ModelSelector(session.id, session.model, detail.models, can("model")) { model ->
                val slash = model.indexOf('/')
                if (slash > 0) command("model") { put("provider", model.take(slash)); put("id", model.substring(slash + 1)) }
            }
            Text("Thinking", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                thinkingLevels.forEach { level ->
                    FilterChip(selected = session.thinking == level, onClick = { command("thinking") { put("level", level) } }, enabled = can("thinking"), label = { Text(level) })
                }
            }
        }
        GitCard(vm, session, state, enabled, can("prompt"), onReviewCommit)
        SessionGlassesCard(vm, detail)
        SectionCard("Session name") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it.take(120) }, Modifier.weight(1f), label = { Text("Session name") }, singleLine = true)
                FilledTonalButton(onClick = { command("rename") { put("name", name) } }, enabled = can("rename") && name.isNotBlank()) { Text("Rename") }
            }
        }
    }
}
