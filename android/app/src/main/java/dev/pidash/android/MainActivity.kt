package dev.pidash.android

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import dev.pidash.android.ui.DashScreen
import dev.pidash.android.ui.PiDashTheme

class MainActivity : ComponentActivity() {
    private val app get() = application as DashApp
    override fun onCreate(savedInstanceState: Bundle?) {
        // The app is always dark, so system bar icons stay light regardless of the system theme.
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent { PiDashTheme { DashScreen() } }
    }
    override fun onStart() {
        super.onStart()
        app.repository.foreground(true)
        // A monitor the system stopped resumes with the next app open; a refused start is reported instead of crashing.
        if (app.background.value && app.repository.host() != null) {
            try { ContextCompat.startForegroundService(this, Intent(this, MonitorService::class.java)) }
            catch (_: IllegalStateException) { app.repository.message("Background monitoring could not restart. Enable it again in Pairing.") }
            catch (_: SecurityException) { app.repository.message("Background monitoring could not restart. Enable it again in Pairing.") }
        }
    }
    override fun onStop() { app.repository.foreground(false); super.onStop() }
}
