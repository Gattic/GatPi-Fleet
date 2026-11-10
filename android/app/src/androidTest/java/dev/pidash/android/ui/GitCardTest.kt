package dev.pidash.android.ui

import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.DraftStorage
import dev.pidash.android.Drafts
import dev.pidash.android.GitAction
import dev.pidash.android.GitBranch
import dev.pidash.android.GitMenu
import dev.pidash.android.GitView
import dev.pidash.android.Session
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class GitCardTest {
    @get:Rule val compose = createComposeRule()
    private val menu = GitMenu("epoch", "revision", "box:/project", "main", "main", "origin/main", 1, 0, "clean", "", "Review changes. Do not push.", listOf(
        GitAction("pull", "Update (pull --ff-only)", null, "Run git pull --ff-only?"),
        GitAction("push", "Send (push)", null, "Publish main to origin/main?"),
        GitAction("switch", "Switch branch", null, null),
    ))
    private val session = Session("s", "r", "project", "/project", "working", "working", null, null, true, null, null, null, null, null, null, null, mapOf("prompt" to null))

    @Test fun menuShowsAllActionsAndBranchChoicesWithoutDispatchingAutomatically() {
        val actions = mutableListOf<String>()
        val view = GitView("s", menu, listOf(GitBranch("main", true, "origin/main"), GitBranch("feature", false, null)), "On branch main")
        compose.setContent { MaterialTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
            GitControls(view, true, true, true, { actions += "refresh" }, {}, { actions += it }, { actions += "branch:$it" }, { actions += "status" }, { actions += "prompt" })
        } } }
        compose.runOnIdle { assertTrue(actions.isEmpty()) }
        for ((label, kind) in listOf("Update (pull --ff-only)" to "pull", "Send (push)" to "push", "Switch branch" to "switch", "View status" to "status", "Ask AI to review/commit" to "prompt", "feature" to "branch:feature", "Refresh git" to "refresh")) {
            compose.onNodeWithText(label).performScrollTo().performClick()
            compose.runOnIdle { assertEquals(kind, actions.last()) }
        }
        compose.onNodeWithText("main · current · tracks origin/main").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("On branch main").performScrollTo().assertIsDisplayed()
    }

    @Test fun pendingOrOfflineStateDisablesMutationsButAllowsInspectionWhenOnline() {
        compose.setContent { MaterialTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
            GitControls(GitView("s", menu), true, false, true, {}, {}, {}, {}, {}, {})
        } } }
        listOf("Update (pull --ff-only)", "Send (push)", "Switch branch", "Ask AI to review/commit").forEach {
            compose.onNodeWithText(it).performScrollTo().assertIsNotEnabled()
        }
        compose.onNodeWithText("View status").performScrollTo().assertIsEnabled()
        compose.onNodeWithText("Refresh git").performScrollTo().assertIsEnabled()
    }

    @Test fun dirtyTreeShowsTheReasonInsteadOfOfferingBranchSwitch() {
        val dirty = menu.copy(tree = "1 untracked", actions = menu.actions.map { if (it.kind == "switch") it.copy(blocked = "Working tree has changes") else it })
        compose.setContent { MaterialTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
            GitControls(GitView("s", dirty), true, true, true, {}, {}, {}, {}, {}, {})
        } } }
        compose.onNodeWithText("Switch branch").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Working tree has changes").performScrollTo().assertIsDisplayed()
    }

    @Test fun actionsRequireConfirmationAndCommitOnlyPreparesAnEditableFollowUpDraft() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        var saved: String? = null
        val drafts = Drafts(object : DraftStorage {
            override fun read() = saved
            override fun save(document: String) { saved = document }
        }) { session.id }
        compose.runOnIdle {
            val vm = DashViewModel(app, drafts)
            vm.git.value = GitView(session.id, menu)
            vm.confirmGit(session, "push")
            assertEquals("Publish main to origin/main?", vm.confirmation.value!!.description)
            assertEquals("push", vm.confirmation.value!!.git!!.kind)
            assertEquals("", drafts.text.value)
            assertTrue(vm.gitCommitPrompt(session))
            assertEquals(menu.commitPrompt, drafts.text.value)
            assertEquals("followUp", vm.delivery.value)
            assertNull(vm.confirmation.value)
            assertNull(vm.git.value)
            assertFalse(vm.busy.value)
            assertFalse("no menu is open, so nothing is prepared or revealed", vm.gitCommitPrompt(session))
        }
    }
}
