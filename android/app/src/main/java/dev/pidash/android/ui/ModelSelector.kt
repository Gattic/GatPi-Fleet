package dev.pidash.android.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp

/** Match every search word in any order, so "sol 6.1" finds "gpt-6.1-sol". */
internal fun modelSuggestions(models: List<String>, query: String): List<String> {
    if (query.isBlank()) return models
    val words = query.trim().split(Regex("\\s+"))
    return models.filter { model -> words.all { model.contains(it, ignoreCase = true) } }
}

@Composable
internal fun ModelSelector(
    sessionId: String,
    currentModel: String?,
    models: List<String>,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    // Dispose the popup's remembered exit transition too, not only the query, when its session changes.
    key(sessionId, currentModel) { ModelSearchField(currentModel, models, enabled, onSelect) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelSearchField(currentModel: String?, models: List<String>, enabled: Boolean, onSelect: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }
    val suggestions = remember(models, query) { modelSuggestions(models, query) }
    val focus = LocalFocusManager.current
    LaunchedEffect(enabled) { if (!enabled) expanded = false }

    ExposedDropdownMenuBox(
        expanded = expanded && enabled,
        onExpandedChange = { expanded = it && enabled },
        modifier = Modifier.fillMaxWidth(),
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it; expanded = true },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryEditable, enabled),
            enabled = enabled,
            singleLine = true,
            label = { Text("Search models") },
            placeholder = { Text("Model name or provider") },
            supportingText = { Text("Current: ${currentModel ?: "not selected"}") },
            trailingIcon = {
                Row {
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = ""; expanded = true }, enabled = enabled) {
                            Icon(Icons.Filled.Close, "Clear model search")
                        }
                    }
                    ExposedDropdownMenuDefaults.TrailingIcon(
                        expanded = expanded && enabled,
                        modifier = Modifier.menuAnchor(MenuAnchorType.SecondaryEditable, enabled),
                    )
                }
            },
        )
        ExposedDropdownMenu(
            expanded = expanded && enabled,
            onDismissRequest = { expanded = false },
            modifier = Modifier.heightIn(max = 280.dp),
        ) {
            if (suggestions.isEmpty()) {
                DropdownMenuItem(
                    text = { Text(if (models.isEmpty()) "No models available for this session" else "No matching models") },
                    onClick = {},
                    enabled = false,
                )
            }
            suggestions.forEach { model ->
                DropdownMenuItem(
                    text = { Text(model) },
                    onClick = {
                        expanded = false
                        query = ""
                        focus.clearFocus()
                        onSelect(model)
                    },
                    enabled = enabled,
                )
            }
        }
    }
}
