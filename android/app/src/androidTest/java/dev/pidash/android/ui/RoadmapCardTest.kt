package dev.pidash.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import dev.pidash.android.Roadmap
import dev.pidash.android.RoadmapEntry
import org.junit.Rule
import org.junit.Test

/** Read-only screen, synthetic data only: no pairing, host requests, provider calls or commands. */
class RoadmapCardTest {
    @get:Rule val compose = createComposeRule()
    private fun plan() = Roadmap("id", "Ship the viewer 界 🧭", "active", "2026-10-22", 1, 4, 1, 0, 2, 1, listOf(
        RoadmapEntry("item", "1", "Build", "active", emptyList()),
        RoadmapEntry("roadmap", "1.1", "Build goals", "active", emptyList()),
        RoadmapEntry("item", "1.1.1", "Terminal viewer", "done", emptyList()),
        RoadmapEntry("item", "1.1.2", "Phone viewer", "blocked", listOf("Waiting for dependency")),
    ), 4)

    @Test fun opensFromSessionCardScrollsNestedContentAndCloses() {
        compose.setContent { PiDashTheme { Box(Modifier.width(320.dp)) { RoadmapCard("s", plan(), true, "Build", true) } } }
        compose.onNodeWithText("Open roadmap").performClick()
        compose.onNodeWithText("Roadmap Viewer").assertIsDisplayed()
        compose.onNodeWithText("Root outcomes: 0/2 complete · 1 blocked").assertIsDisplayed()
        compose.onNodeWithText("Workflow: 1/4 complete · 1 blocked").assertIsDisplayed()
        compose.onNodeWithTag("roadmap-entries").performScrollToIndex(4)
        compose.onNodeWithText("#1.1.2 · blocked").assertIsDisplayed()
        compose.onNodeWithText("Note: Waiting for dependency").assertIsDisplayed()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("Roadmap Viewer").assertDoesNotExist()
        compose.onNodeWithText("Open roadmap").assertIsDisplayed()
    }

    @Test fun liveViewerUpdatesShowsStaleAndLimitedStateAndClearsWithoutLeavingSession() {
        val roadmap = mutableStateOf<Roadmap?>(plan())
        val fresh = mutableStateOf(true)
        compose.setContent { PiDashTheme { RoadmapCard("s", roadmap.value, roadmap.value != null, null, fresh.value) } }
        compose.onNodeWithText("Open roadmap").performClick()
        compose.runOnUiThread { roadmap.value = plan().copy(lifecycle = "shelved", totalEntries = 1000); fresh.value = false }
        compose.onNodeWithText("Lifecycle: shelved").assertIsDisplayed()
        compose.onNodeWithText("Last known roadmap", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Showing first 4 of 1000 entries (snapshot limit).").assertIsDisplayed()
        compose.runOnUiThread { roadmap.value = null }
        compose.onNodeWithText("No roadmap published for this session.").assertIsDisplayed()
    }

    @Test fun missingPublisherDetailIsNotAnEmptyRoadmapAndSelectionResetsViewer() {
        val session = mutableStateOf("first")
        compose.setContent { PiDashTheme { RoadmapCard(session.value, null, true, null, true) } }
        compose.onNodeWithText("Open roadmap").performClick()
        compose.onNodeWithText("Nested roadmap detail unavailable.", substring = true).assertIsDisplayed()
        compose.runOnUiThread { session.value = "replacement" }
        compose.onNodeWithText("Roadmap Viewer").assertDoesNotExist()
        compose.onNodeWithText("Open roadmap").assertIsDisplayed()
    }

    @Test fun largeRoadmapIsLazilyScrollableToTheLastEntry() {
        val plan = plan().copy(entries = (1..200).map { RoadmapEntry("item", "$it", "Goal $it", "pending", emptyList()) }, totalEntries = 200)
        compose.setContent { PiDashTheme { RoadmapCard("s", plan, true, null, true) } }
        compose.onNodeWithText("Open roadmap").performClick()
        compose.onNodeWithTag("roadmap-entries").performScrollToIndex(200)
        compose.onNodeWithText("Goal 200").assertIsDisplayed()
    }
}
