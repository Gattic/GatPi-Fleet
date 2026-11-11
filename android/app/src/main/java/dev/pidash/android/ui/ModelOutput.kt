package dev.pidash.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pidash.android.Detail
import dev.pidash.android.Markdown
import dev.pidash.android.Tool

/** Characters of the latest reply the card renders; the viewer reads the whole bounded reply. */
private const val REPLY_PREVIEW_CHARS = 2000

@Composable
internal fun ExchangeCard(detail: Detail) {
    var markdown by rememberSaveable(detail.session.id) { mutableStateOf(true) }
    var viewer by rememberSaveable(detail.session.id) { mutableStateOf(false) }
    val reply = detail.reply.orEmpty()
    SectionCard("Latest exchange") {
        Text("Prompt", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(detail.prompt ?: "No prompt preview", style = MaterialTheme.typography.bodyMedium)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Reply (bounded; not a full transcript)", Modifier.weight(1f),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = { viewer = true }, enabled = reply.isNotBlank()) { Text("Maximize") }
        }
        if (reply.isBlank()) {
            Text("No completed reply", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf(true to "Markdown", false to "Plain text").forEachIndexed { index, (value, label) ->
                    SegmentedButton(markdown == value, { markdown = value }, SegmentedButtonDefaults.itemShape(index, 2)) { Text(label) }
                }
            }
            ReplyPreview(reply, markdown)
            if (reply.length > REPLY_PREVIEW_CHARS) {
                Hint("Showing the first $REPLY_PREVIEW_CHARS of ${reply.length} characters. Maximize to read the full reply.")
            }
        }
    }
    if (viewer) ReplyViewerDialog(detail.session.label, reply, markdown) { viewer = false }
}

@Composable
private fun ReplyPreview(reply: String, markdown: Boolean) {
    val preview = Markdown.preview(reply, REPLY_PREVIEW_CHARS)
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
        Column(Modifier.padding(12.dp)) {
            if (markdown) MarkdownView(preview, Modifier.testTag("reply-markdown"))
            else SelectionContainer { Text(preview, Modifier.testTag("reply-plain"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Full-screen reading of the selected session's latest reply; no command or network mutation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReplyViewerDialog(label: String, reply: String, initialMarkdown: Boolean, onClose: () -> Unit) {
    var markdown by rememberSaveable { mutableStateOf(initialMarkdown) }
    val context = LocalContext.current
    ModalBottomSheet(onDismissRequest = onClose, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), dragHandle = null) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Model output", style = MaterialTheme.typography.titleLarge)
                        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    TextButton(onClick = onClose) { Text("Close") }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                        listOf(true to "Markdown", false to "Plain text").forEachIndexed { index, (value, labelText) ->
                            SegmentedButton(markdown == value, { markdown = value }, SegmentedButtonDefaults.itemShape(index, 2)) { Text(labelText) }
                        }
                    }
                    OutlinedButton(onClick = { copyReply(context, reply) }, enabled = reply.isNotBlank()) { Text("Copy") }
                }
                if (reply.isBlank()) {
                    Text("No completed reply")
                } else if (markdown) {
                    val blocks = remember(reply) { Markdown.parse(reply) }
                    LazyColumn(Modifier.weight(1f).testTag("reply-viewer"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        itemsIndexed(blocks) { _, block -> MarkdownBlock(block) }
                    }
                } else {
                    val lines = remember(reply) { reply.lines() }
                    LazyColumn(Modifier.weight(1f).testTag("reply-viewer"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        itemsIndexed(lines) { _, line -> Text(line.ifEmpty { " " }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            }
        }
    }
}

private fun copyReply(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Model output", text))
}

/** Recent tool runs; a row expands to the arguments the model supplied and the output the tool returned. */
@Composable
internal fun ToolsCard(tools: List<Tool>) {
    SectionCard("Recent tools") {
        if (tools.isEmpty()) {
            Text("No recent tools", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            if (tools.none { !it.arguments.isNullOrBlank() || !it.result.isNullOrBlank() }) {
                Hint("This host does not send tool arguments or output. Update the host and /reload the session.")
            }
            tools.asReversed().forEach { tool -> ToolRow(tool) }
        }
    }
}

@Composable
private fun ToolRow(tool: Tool) {
    // Keyed by the run, so expanding a row survives a newer tool arriving above it.
    var open by rememberSaveable(tool.name, tool.startedAt) { mutableStateOf(false) }
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().clickable { open = !open }.padding(12.dp).testTag("tool-${tool.name}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                    when {
                        tool.running -> CircularProgressIndicator(Modifier.size(12.dp), color = Pi.Working, strokeWidth = 2.dp)
                        tool.failed -> Icon(Icons.Filled.Close, "failed", Modifier.size(16.dp), tint = Pi.Error)
                        else -> Icon(Icons.Filled.Check, "finished", Modifier.size(16.dp), tint = Pi.Dim)
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(tool.name, style = MaterialTheme.typography.labelLarge, fontFamily = FontFamily.Monospace)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(toolStatus(tool), style = MaterialTheme.typography.labelSmall,
                            color = when { tool.failed -> Pi.Error; tool.running -> Pi.Working; else -> MaterialTheme.colorScheme.onSurfaceVariant })
                        if (tool.detail.isNotBlank()) {
                            Text(tool.detail, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                Text(if (open) "Hide" else "Details", style = MaterialTheme.typography.labelMedium, color = Pi.Accent)
            }
            if (open) {
                Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!tool.arguments.isNullOrBlank()) ToolText("Arguments", tool.arguments)
                    if (!tool.result.isNullOrBlank()) ToolText(if (tool.failed) "Error output" else "Output", tool.result, tool.failed)
                    if (tool.arguments.isNullOrBlank() && tool.result.isNullOrBlank()) {
                        Hint(if (tool.running) "Running; output appears when the tool finishes." else "No arguments or output recorded for this run.")
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolText(label: String, text: String, error: Boolean = false) {
    Text(label, style = MaterialTheme.typography.labelSmall,
        color = if (error) Pi.Error else MaterialTheme.colorScheme.onSurfaceVariant)
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
        SelectionContainer {
            Text(text, Modifier.padding(10.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                color = if (error) Pi.Error else MaterialTheme.colorScheme.onSurface)
        }
    }
}

private fun toolStatus(tool: Tool): String = when {
    tool.running -> "running"
    tool.failed -> "failed"
    else -> tool.duration?.let { "finished in ${durationText(it)}" } ?: "finished"
}

private fun durationText(milliseconds: Long): String = when {
    milliseconds < 1000 -> "${milliseconds}ms"
    milliseconds < 60_000 -> "%.1fs".format(milliseconds / 1000.0)
    else -> "${milliseconds / 60_000}m${(milliseconds % 60_000) / 1000}s"
}
