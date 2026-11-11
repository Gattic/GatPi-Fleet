package dev.pidash.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.pidash.android.Markdown
import dev.pidash.android.MdBlock
import dev.pidash.android.MdSpan

/** Renders a whole bounded Markdown reply as a stack of blocks. */
@Composable
internal fun MarkdownView(markdown: String, modifier: Modifier = Modifier) {
    val blocks = remember(markdown) { Markdown.parse(markdown) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        blocks.forEach { MarkdownBlock(it) }
    }
}

/** One parsed Markdown block; [MarkdownView] and the full-screen viewer share this rendering. */
@Composable
internal fun MarkdownBlock(block: MdBlock, modifier: Modifier = Modifier) {
    when (block) {
        is MdBlock.Heading -> Text(
            annotated(block.text), modifier.fillMaxWidth(),
            style = when (block.level) {
                1 -> MaterialTheme.typography.headlineSmall
                2 -> MaterialTheme.typography.titleLarge
                3 -> MaterialTheme.typography.titleMedium
                else -> MaterialTheme.typography.bodyLarge
            },
            fontWeight = if (block.level >= 4) FontWeight.Bold else null,
        )
        is MdBlock.Paragraph -> SelectionContainer {
            Text(annotated(block.text), modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyLarge)
        }
        is MdBlock.Code -> CodeBlock(block.language, block.code, modifier)
        is MdBlock.ListBlock -> Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            block.items.forEachIndexed { index, item ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        if (block.ordered) "${block.start + index}." else "•",
                        style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    SelectionContainer { Text(annotated(item), style = MaterialTheme.typography.bodyLarge) }
                }
            }
        }
        is MdBlock.Quote -> Row(modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline))
            Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                block.blocks.forEach { MarkdownBlock(it) }
            }
        }
        MdBlock.Rule -> HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

@Composable
private fun CodeBlock(language: String?, code: String, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (!language.isNullOrBlank()) {
                Text(language, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            SelectionContainer {
                Text(code, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Inline spans of one block; links open only the web/mail URLs the parser accepted. */
@Composable
private fun annotated(text: String): AnnotatedString {
    val codeBackground = MaterialTheme.colorScheme.surfaceContainerHighest
    return buildAnnotatedString {
        Markdown.inline(text).forEach { span ->
            when (span) {
                is MdSpan.Text -> append(span.text)
                is MdSpan.Strong -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(span.text) }
                is MdSpan.Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(span.text) }
                is MdSpan.Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(span.text) }
                is MdSpan.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(span.text) }
                is MdSpan.Link -> withLink(LinkAnnotation.Url(span.url)) {
                    withStyle(SpanStyle(color = Pi.Accent, textDecoration = TextDecoration.Underline)) { append(span.text) }
                }
            }
        }
    }
}
