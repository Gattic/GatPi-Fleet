package dev.pidash.android.ui

import android.app.Application
import android.os.SystemClock
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.HostUsage
import dev.pidash.android.RemoteUsageHost
import dev.pidash.android.Screen
import dev.pidash.android.UsageMeasure
import dev.pidash.android.UsageRange
import dev.pidash.android.UsageReport
import dev.pidash.android.UsageSnapshot
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test

/**
 * The real app shell showing Usage where room is tightest: a 320dp-wide screen with the system font at 200%.
 * No gateway is contacted: the view model is seeded, and the device has no pairing under this package.
 */
class UsageNarrowScreenTest {
    @get:Rule val compose = createComposeRule()

    private fun vm() = DashViewModel(InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application)

    private fun narrow(vm: DashViewModel) = compose.setContent {
        CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
            // Narrow, not short: the by-host card is one list item and must fit to be checked row by row.
            MaterialTheme { Box(Modifier.width(320.dp).height(1400.dp)) { DashScreen(vm) } }
        }
    }

    /**
     * Whether `text` is cut off: a line ended in an ellipsis, or it needs more lines than it may have.
     * Not `hasVisualOverflow`, which is also true for text that merely does not fill the box it was given.
     */
    private fun cutOff(text: String): Boolean {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
        val layout = layouts.single()
        return layout.didOverflowHeight || (0 until layout.lineCount).any(layout::isLineEllipsized)
    }

    @Test fun remoteHostsAreNamedAndMarkedInTheRealScreen() {
        val long = "rob@a-training-node-with-a-very-long-name.cluster.example.org"
        val measure = UsageMeasure(emptyList(), emptyList(), emptyList(),
            listOf(HostUsage(null, 1234.5), HostUsage("box00", 8765.4), HostUsage("boxhome", 1.0), HostUsage(long, 0.0)))
        val report = UsageReport(1_000_000_000_000L, false, emptyList(), emptyList(),
            listOf(RemoteUsageHost("box00", "connecting", false), RemoteUsageHost("boxhome", "offline", false), RemoteUsageHost(long, "online", true)),
            UsageReport.RANGES.map { UsageRange(it, 1, 10001.0, 1e9, 0.0, measure, measure) })
        val vm = vm()
        vm.usage.value = UsageSnapshot(report, SystemClock.elapsedRealtime())
        vm.screen.value = Screen.Usage
        narrow(vm)

        // The screen scrolls; each row is brought into view before it is checked.
        fun shown(text: String) {
            compose.onNode(hasScrollAction()).performScrollToNode(hasText(text))
            try { compose.onNodeWithText(text).assertIsDisplayed() } catch (e: AssertionError) { throw AssertionError("\"$text\" is not displayed", e) }
        }
        for (text in listOf("COST BY HOST", "box00", "connecting", "boxhome", "offline", "indexing")) shown(text)
        // A name may wrap onto a second line, but the machines that are not remote are not left as "Gatewa…".
        assertFalse("the gateway row's name is cut off", cutOff("Gateway host"))
        for (host in listOf("box00", "boxhome")) assertFalse("$host is cut off", cutOff(host))
        // The figure is never the part that is shortened.
        shown("88% · $8765")
        assertFalse("a figure is cut off", cutOff("88% · $8765"))
        assertFalse("a mark is cut off", cutOff("connecting"))
    }

    @Test fun anOlderGatewaysRefusalIsReadableInFull() {
        // What a gateway that predates remote-host usage sends: no per-host usage anywhere.
        val old = JSONObject().put("at", 1L).put("indexing", false).put("quota", JSONObject.NULL).put("cooldowns", JSONObject.NULL).put("ranges", JSONArray())
        val refusal = runCatching { UsageReport.parse(old) }.exceptionOrNull()!!.message!!
        val vm = vm()
        vm.screen.value = Screen.Usage
        vm.repository.message(refusal)
        narrow(vm)

        compose.onNodeWithText(refusal).assertIsDisplayed()
        assertFalse("the instruction is cut off: \"$refusal\"", cutOff(refusal))
    }
}
