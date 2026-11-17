package dev.pidash.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import dev.pidash.android.MonitorService
import dev.pidash.android.Pairing
import dev.pidash.android.Screen

@Composable
internal fun PairingScreen(vm: DashViewModel, host: String?) {
    var document by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf<Pairing?>(null) }
    var checked by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val app = vm.app
    val background by app.background.collectAsStateWithLifecycle()
    // Notifications need permission before the monitor can deliver anything.
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val action = pending
        pending = null
        if (granted) action?.invoke() else vm.repository.message("Allow notifications to be told when a session needs you.")
    }
    fun notificationsThen(action: () -> Unit) {
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) action()
        else { pending = action; request.launch(Manifest.permission.POST_NOTIFICATIONS) }
    }
    fun startBackground() {
        // Set the preference first: the service reads it to decide whether to stay after this start.
        app.setBackground(true)
        try { ContextCompat.startForegroundService(context, Intent(context, MonitorService::class.java)) }
        catch (_: SecurityException) { app.setBackground(false); vm.repository.message("Background monitoring could not start. Enable it again.") }
        catch (_: IllegalStateException) { app.setBackground(false); vm.repository.message("Background monitoring could not start. Keep pi-dash open and try again.") }
    }
    fun stopBackground() {
        app.setBackground(false)
        context.startService(Intent(context, MonitorService::class.java).setAction(MonitorService.ACTION_STOP_BACKGROUND))
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Secure local pairing", style = MaterialTheme.typography.headlineSmall)
            Text("The phone talks directly to your host's gateway over TLS. No cloud relay is used.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        SectionCard("This device") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Filled.Lock, null, tint = if (host != null) Pi.Working else Pi.Dim)
                Column(Modifier.weight(1f)) {
                    Text(host ?: "No host paired", style = MaterialTheme.typography.titleSmall)
                    Text(if (host != null) "Paired host" else "Pair below to begin", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            OutlinedButton(
                onClick = {
                    context.stopService(Intent(context, MonitorService::class.java))
                    app.setBackground(false)
                    vm.repository.logout(); vm.resetDrafts(); document = ""; preview = null
                },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Pi.Error), border = BorderStroke(1.dp, Pi.Error.copy(alpha = 0.6f)),
            ) { Text("Disconnect and erase local credentials/drafts") }
            Hint("Erasing does not revoke this device's token on the host.")
        }
        SectionCard("Background monitoring") {
            SwitchRow(
                "Background monitoring", "Keeps the host connection open after you close pi-dash and notifies you when a session starts needing you. Names and status only. It stops when you turn this off, force-stop the app or reboot; battery policy can still stop it.",
                background, enabled = host != null,
            ) { on ->
                if (on) notificationsThen(::startBackground) else stopBackground()
            }
            Hint("The glasses alert card is a separate setting under Glasses.")
            if (host == null) Hint("Pair with your host before enabling background monitoring.")
        }
        SectionCard("Pair a host") {
            Step(1, "On your host run:")
            Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
                SelectionContainer { Text("pi-dash-server pair --name PHONE", Modifier.padding(12.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
            }
            Step(2, "Paste its sensitive JSON here.")
            OutlinedTextField(
                document, { document = it.take(16_000); preview = null; checked = false }, Modifier.fillMaxWidth(),
                label = { Text("Pairing JSON") }, minLines = 3, maxLines = 6,
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            )
            Step(3, "Verify the certificate fingerprint against the host before trusting it.")
            OutlinedButton(onClick = { try { preview = Pairing.parse(document) } catch (e: Exception) { vm.repository.message(e.message ?: "Invalid pairing") } }, enabled = document.isNotBlank()) {
                Text("Inspect certificate")
            }
            preview?.let { p ->
                Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerLowest) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(p.urls.joinToString("\n"), style = MaterialTheme.typography.titleSmall)
                        SelectionContainer { Text("SHA-256\n${p.fingerprint}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    }
                }
                Row(
                    Modifier.fillMaxWidth().toggleable(checked, role = Role.Checkbox, onValueChange = { checked = it }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked, null)
                    Text("Fingerprint matches the host", Modifier.padding(start = 8.dp))
                }
                Button(
                    onClick = { vm.run { vm.repository.pair(document); vm.resetDrafts(); document = ""; preview = null; checked = false; vm.screen.value = Screen.Sessions } },
                    enabled = checked, modifier = Modifier.fillMaxWidth(),
                ) { Text("Trust and pair") }
            }
        }
        Notice("Pairing grants the phone your host user's pi session privileges. Prompts can cause file changes and command execution. Revoke lost devices on the host.", Pi.Waiting)
        Hint("This APK targets Android 12+. Background monitoring is opt-in and needs notification permission; Android battery policy, force-stop or reboot can still stop it.")
    }
}

/** A titled switch row whose whole line is the tap target, like the Glasses controls. */
@Composable
private fun SwitchRow(title: String, description: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked, null, enabled = enabled)
    }
}

@Composable
private fun Step(number: Int, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Surface(shape = MaterialTheme.shapes.extraLarge, color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer) {
            Text("$number", Modifier.padding(horizontal = 9.dp, vertical = 2.dp), style = MaterialTheme.typography.labelLarge)
        }
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}
