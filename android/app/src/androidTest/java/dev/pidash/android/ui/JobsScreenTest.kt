package dev.pidash.android.ui

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.Dashboard
import dev.pidash.android.Screen
import dev.pidash.android.Session
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Real Jobs screen and its link from Sessions; the view model never contacts the host. */
class JobsScreenTest {
    @get:Rule val compose = createComposeRule()

    private fun vm() = DashViewModel(InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application)

    private fun session(id: String, label: String, kind: String, name: String, detail: String?): Session =
        Session.parse(JSONObject()
            .put("id", id).put("revision", "r").put("label", label).put("project", "/work/$label")
            .put("status", JSONObject().put("kind", "working").put("label", "working").put("since", 1))
            .put("attentionKey", JSONObject.NULL).put("connected", true)
            .put("model", "opus").put("thinking", "high").put("contextPercent", 20.0)
            .put("plan", JSONObject.NULL)
            .put("resources", JSONObject().put("cpu", 0.2).put("memory", 1e8).put("gpuMemory", JSONObject.NULL)
                .put("background", JSONArray().put(JSONObject().put("kind", kind).put("label", name)
                    .put("detail", detail ?: JSONObject.NULL).put("startedAt", 1_000L).put("cpu", 0.3).put("memory", 1e8))))
            .put("usage", JSONObject.NULL).put("commands", JSONObject()))

    @Test fun jobsShowWhatEachOneRunsAndOpenTheSession() {
        val vm = vm()
        val first = session("a", "project-a", "job", "nightly-build", "npm run test")
        val second = session("b", "project-b", "subagent", "coder", null)
        val state = Dashboard(sessions = listOf(first, second), updatedAt = 61_000L)
        compose.setContent { MaterialTheme { JobsScreen(vm, state) } }
        compose.onNodeWithText("1 job · 1 subagent across 2 sessions").assertIsDisplayed()
        compose.onNodeWithText("nightly-build").assertIsDisplayed()
        compose.onNodeWithText("npm run test").assertIsDisplayed()
        compose.onNodeWithText("No command or task recorded").assertIsDisplayed()
        compose.onNodeWithText("project-b · /work/project-b").assertIsDisplayed()
        compose.onNodeWithText("nightly-build").performClick()
        assertEquals(Screen.Session, vm.screen.value)
    }

    @Test fun sessionsLinkToJobsAndNameBackgroundWork() {
        val vm = vm()
        val state = Dashboard(sessions = listOf(session("a", "project-a", "job", "nightly-build", "npm run test")), updatedAt = 61_000L)
        compose.setContent { MaterialTheme { SessionsScreen(vm, state) } }
        compose.onNodeWithText("Jobs · 1").assertIsDisplayed()
        compose.onNodeWithText("BG").assertIsDisplayed()
        compose.onNodeWithText("job nightly-build 1m00s").assertIsDisplayed()
        compose.onNodeWithText("Jobs · 1").performClick()
        assertEquals(Screen.Jobs, vm.screen.value)
    }
}
