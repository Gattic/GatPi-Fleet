package dev.pidash.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Even Realities G1", style = MaterialTheme.typography.titleLarge)
        Text("Release the glasses from Even Realities/G1 PoC first. Connect discovers matching G1 arms; choose a pair only if more than one is found.")
        Text(state.connectionSummary())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (running) {
            Button(onClick = onDisconnect) { Text("Disconnect and release glasses") }
        } else {
            Button(onClick = onConnect, enabled = paired) { Text("Connect") }
            if (!paired) Text("Pair with your host before connecting glasses.")
        }
        for (channel in state.pairs) {
            Button(onClick = { onChoosePair(channel) }, enabled = running) { Text("G1 pair $channel") }
        }
    }
}
