package dev.pidash.android.ui

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.performTextReplacement
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.Project
import dev.pidash.android.Projects
import dev.pidash.android.Unreachable
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Real Projects screen and view model. The view model is kept busy, so it never contacts the host. */
class ProjectsScreenTest {
    @get:Rule val compose = createComposeRule()
    private val first = Project("a", null, "first", "/work/first")
    private val second = Project("b", null, "second", "/work/second")
    private fun vm() = DashViewModel(InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application)

    @Test fun reopeningShowsOnlyTheListFetchedForThisVisit() {
        val vm = vm()
        vm.projects.value = Projects(listOf(first, second), emptyList())
        compose.setContent { MaterialTheme { ProjectsScreen(vm, enabled = true) } }
        compose.onNodeWithText(first.path).assertIsDisplayed()

        // The host's order may have changed since: the earlier list must not stand in for this visit's.
        vm.busy.value = true
        compose.runOnUiThread { vm.openProjects() }
        compose.onNodeWithText("Loading projects…").assertIsDisplayed()
        compose.onNodeWithText(first.path).assertDoesNotExist()
        compose.onNodeWithText(second.path).assertDoesNotExist()
        compose.onNodeWithText("No projects", substring = true).assertDoesNotExist()

        // Nothing was fetched for this visit (another action held the view model), so say so.
        vm.busy.value = false
        compose.onNodeWithText("Projects were not loaded", substring = true).assertIsDisplayed()

        vm.projects.value = Projects(listOf(second, first), emptyList())
        compose.onNodeWithText("Projects were not loaded", substring = true).assertDoesNotExist()
        val top = compose.onNodeWithText(second.path).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top
        assertTrue(top < compose.onNodeWithText(first.path).assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top)

        vm.projects.value = Projects(emptyList(), emptyList())
        compose.onNodeWithText("No projects yet", substring = true).assertIsDisplayed()
    }

    @Test fun searchMatchesNamesPathsAndHostsAndCanBeCleared() {
        val vm = vm()
        val remote = Project("c", "box00", "remote", "/srv/special/remote")
        vm.projects.value = Projects(listOf(first, second, remote), listOf(Unreachable("box01", "offline")))
        compose.setContent { MaterialTheme { ProjectsScreen(vm, enabled = true) } }
        val search = compose.onNodeWithText("Search projects")
        search.performTextReplacement("  FIRST  ")
        compose.onNodeWithText(first.path).assertIsDisplayed()
        compose.onNodeWithText(second.path).assertDoesNotExist()
        compose.onNodeWithText(remote.path).assertDoesNotExist()
        search.performTextReplacement("special")
        compose.onNodeWithText(remote.path).assertIsDisplayed()
        compose.onNodeWithText(first.path).assertDoesNotExist()
        search.performTextReplacement("BOX00")
        compose.onNodeWithText(remote.path).assertIsDisplayed()
        compose.onNodeWithText(first.path).assertDoesNotExist()
        search.performTextReplacement("absent")
        compose.onNodeWithText("No projects match your search.").assertIsDisplayed()
        compose.onNodeWithText("box01: offline").assertIsDisplayed()
        compose.onNodeWithContentDescription("Clear project search").performClick()
        compose.onNodeWithText("No projects match your search.").assertDoesNotExist()
        compose.onNodeWithText(first.path).assertIsDisplayed()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(remote.path))
        compose.onNodeWithText(remote.path).assertIsDisplayed()
    }

    @Test fun remoteHostsProjectsComeUnderTheirHostAndSilentHostsAreNamed() {
        val vm = vm()
        val remote = Project("c", "box00", "remote", "/home/me/remote")
        vm.projects.value = Projects(listOf(first, remote), listOf(Unreachable("box01", "box01 is offline")))
        compose.setContent { MaterialTheme { ProjectsScreen(vm, enabled = true) } }
        // Section labels are drawn in capitals.
        val header = compose.onNodeWithText("BOX00").assertIsDisplayed().fetchSemanticsNode().boundsInRoot.top
        assertTrue(compose.onNodeWithText(first.path).fetchSemanticsNode().boundsInRoot.top < header)
        assertTrue(header < compose.onNodeWithText(remote.path).fetchSemanticsNode().boundsInRoot.top)
        compose.onNodeWithText("box01: box01 is offline").assertIsDisplayed()
    }
}
