package dev.pidash.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.pidash.g1.GlassesState

/** Connection feedback belongs to the glasses, not the gateway's changing status message. */
@Composable
internal fun GlassesConnectionControls(
    state: GlassesState,
    running: Boolean,
    paired: Boolean,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onChoosePair: (String) -> Unit,
) {
    val linkColor = when {
        state.error != null -> Pi.Error
        state.left == "ready" && state.right == "ready" -> Pi.Working
        running -> Pi.Waiting
        else -> Pi.Dim
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Even Realities G1", style = MaterialTheme.typography.titleLarge)
        Text("Release the glasses from Even Realities/G1 PoC first. Connect discovers matching G1 arms; choose a pair only if more than one is found.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                StatusDot(linkColor, size = 10.dp)
                Text(state.connectionSummary(), style = MaterialTheme.typography.bodyMedium)
            }
        }
        state.error?.let { Notice(it, Pi.Error) }
        if (running) {
            OutlinedButton(
                onClick = onDisconnect, modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Pi.Error), border = BorderStroke(1.dp, Pi.Error.copy(alpha = 0.6f)),
            ) { Text("Disconnect and release glasses") }
        } else {
            Button(onClick = onConnect, enabled = paired, modifier = Modifier.fillMaxWidth()) { Text("Connect") }
            if (!paired) Hint("Pair with your host before connecting glasses.")
        }
        for (channel in state.pairs) {
            FilledTonalButton(onClick = { onChoosePair(channel) }, enabled = running, modifier = Modifier.fillMaxWidth()) { Text("G1 pair $channel") }
        }
    }
}
