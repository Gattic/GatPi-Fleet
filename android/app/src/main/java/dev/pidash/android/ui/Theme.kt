package dev.pidash.android.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** pi's dark palette, as used by the terminal dashboard (src/dashboard/ui/theme.ts). */
object Pi {
    val Accent = Color(0xFF69ADD0)
    val Violet = Color(0xFFA798D7)
    val Working = Color(0xFF68B78D)
    val Waiting = Color(0xFFCD9A22)
    val Error = Color(0xFFEA7F81)
    val Text = Color(0xFFDEE0E1)
    val Muted = Color(0xFF9DA5A9)
    val Dim = Color(0xFF747E83)
}

/** Same meaning as the terminal dashboard's status cell: green working, amber needs you, red failing. */
fun statusColor(kind: String): Color = when (kind) {
    "working" -> Pi.Working
    "needs-you", "stalled" -> Pi.Waiting
    "error", "rate-limited" -> Pi.Error
    else -> Pi.Muted
}

/** Green under 60 %, amber under 85 %, red above, as in the terminal dashboard. */
fun levelColor(fraction: Double): Color = when {
    fraction >= 0.85 -> Pi.Error
    fraction >= 0.6 -> Pi.Waiting
    else -> Pi.Working
}

private val colors = darkColorScheme(
    primary = Pi.Accent, onPrimary = Color(0xFF07202C),
    primaryContainer = Color(0xFF213B49), onPrimaryContainer = Color(0xFFCBE6F4),
    inversePrimary = Color(0xFF2F6F8F),
    secondary = Pi.Violet, onSecondary = Color(0xFF221A3B),
    secondaryContainer = Color(0xFF3E3656), onSecondaryContainer = Color(0xFFE6DEFF),
    tertiary = Pi.Waiting, onTertiary = Color(0xFF2A1E00),
    tertiaryContainer = Color(0xFF473410), onTertiaryContainer = Color(0xFFFFDEA0),
    error = Pi.Error, onError = Color(0xFF3B0A0C),
    errorContainer = Color(0xFF5A2326), onErrorContainer = Color(0xFFFFDAD9),
    background = Color(0xFF101417), onBackground = Pi.Text,
    surface = Color(0xFF101417), onSurface = Pi.Text,
    surfaceVariant = Color(0xFF2D3438), onSurfaceVariant = Pi.Muted,
    surfaceTint = Pi.Accent,
    inverseSurface = Pi.Text, inverseOnSurface = Color(0xFF1E2326),
    outline = Color(0xFF5B666C), outlineVariant = Color(0xFF2D3438),
    surfaceBright = Color(0xFF353C40), surfaceDim = Color(0xFF101417),
    surfaceContainerLowest = Color(0xFF0C0F11), surfaceContainerLow = Color(0xFF171C1F),
    surfaceContainer = Color(0xFF1E2326), surfaceContainerHigh = Color(0xFF252A2E),
    surfaceContainerHighest = Color(0xFF2D3438),
)

private val typography = Typography().run {
    copy(
        headlineSmall = headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = titleMedium.copy(fontWeight = FontWeight.SemiBold),
        titleSmall = titleSmall.copy(fontWeight = FontWeight.SemiBold),
    )
}

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun PiDashTheme(content: @Composable () -> Unit) = MaterialTheme(colors, shapes, typography, content)
