package dev.pidash.android

import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
    override fun onStart() { super.onStart(); app.repository.foreground(true) }
    override fun onStop() { app.repository.foreground(false); super.onStop() }
}
