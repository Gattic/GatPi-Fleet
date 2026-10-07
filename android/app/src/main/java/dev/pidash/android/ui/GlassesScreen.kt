package dev.pidash.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pidash.android.DashViewModel
import dev.pidash.android.GlassesService
import dev.pidash.g1.G1Diagnostics
import dev.pidash.g1.GlassesState

@Composable
internal fun GlassesScreen(vm: DashViewModel) {
    val context = LocalContext.current
    val app = vm.app
    val glasses by app.glassesState.collectAsStateWithLifecycle()
    val running by app.monitoring.collectAsStateWithLifecycle()
    val alerts by app.attentionAlerts.collectAsStateWithLifecycle()
    var diagnostics by remember { mutableStateOf(false) }
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
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionCard(null) {
            GlassesConnectionControls(
                state = glasses, running = running, paired = vm.repository.host() != null,
                onConnect = {
                    app.glassesState.value = GlassesState(session = "Requesting Bluetooth and notification permissions…")
                    request.launch(permissions)
                },
                onDisconnect = { context.stopService(Intent(context, GlassesService::class.java)) },
                onChoosePair = { app.glasses?.selectPair(it) },
            )
        }
        SectionCard("Display") {
            GlassesPagingControls(glasses, running) { app.glasses?.page(it) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { app.display() }, Modifier.weight(1f)) { Text("Overview") }
                OutlinedButton(onClick = { app.glasses?.hide() }, Modifier.weight(1f), enabled = running) { Text("Hide") }
            }
            Hint("Pin sessions or show reply excerpts from session detail.")
        }
        SectionCard("Alerts") {
            Row(
                Modifier.fillMaxWidth().toggleable(alerts, role = Role.Switch, onValueChange = app::alerts),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Attention alerts", style = MaterialTheme.typography.titleSmall)
                    Text("Names/status only, when a session starts needing you", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(alerts, null)
            }
        }
        SectionCard("How it works") {
            Hint("Paging is on this phone; single taps are not supported. Double-tap dismissal and Silent Mode suppress automatic redisplay. Triple taps toggle Silent Mode. Glasses gestures never approve actions.")
            Hint("Monitoring uses a foreground service and bounded wake lock while your phone is locked. It stops after 12 hours, force-stop or reboot. Battery usage must be measured on your phone. Stop here before returning to the Even app.")
        }
        SectionCard("Connection diagnostics") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Metadata only; never payloads, addresses or displayed text.", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { diagnostics = !diagnostics }) { Text(if (diagnostics) "Hide log" else "Show log") }
            }
            if (diagnostics) Text(G1Diagnostics.snapshot().ifEmpty { "No events yet" }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        }
    }
}
