package dev.pidash.android.ui

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.Dashboard
import dev.pidash.android.Detail
import dev.pidash.android.DraftStorage
import dev.pidash.android.Drafts
import dev.pidash.android.GitAction
import dev.pidash.android.GitMenu
import dev.pidash.android.GitView
import dev.pidash.android.Session
import org.junit.Rule
import org.junit.Test

class SessionReviewScrollTest {
    @get:Rule val compose = createComposeRule()

    @Test fun reviewCommitBringsThePreparedDraftIntoView() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val session = Session("s", "r", "project", "/project", "working", "working", null, null, true,
            null, null, null, null, null, null, null, mapOf("prompt" to null))
        val menu = GitMenu("epoch", "revision", "box:/project", "main", "main", "origin/main", 1, 0, "clean", "",
            "Review changes. Do not push.", listOf(
                GitAction("pull", "Update (pull --ff-only)", null, "Run git pull --ff-only?"),
                GitAction("push", "Send (push)", null, "Publish main to origin/main?"),
                GitAction("switch", "Switch branch", null, null),
            ))
        val vm = DashViewModel(app, Drafts(object : DraftStorage {
            override fun read(): String? = null
            override fun save(document: String) = Unit
        }) { session.id })
        vm.git.value = GitView(session.id, menu)
        compose.setContent {
            MaterialTheme {
                // A phone-sized viewport: the expanded Git menu pushes Prompt below the fold, so the
                // review tap must move the page rather than leave it on whatever came next.
                Box(Modifier.height(400.dp)) {
                    SessionScreen(vm, Dashboard(detail = Detail(session, null, emptyList(), null, null, null,
                        emptyList(), emptyList(), emptyList()), epoch = "epoch", fresh = true), enabled = true)
                }
            }
        }

        compose.onNodeWithText("Ask AI to review/commit").performScrollTo().performClick()

        // Closing the git menu collapses the Git card; the page must follow the draft into Prompt
        // rather than staying at the old offset (which lands on a later section).
        compose.waitUntil(5_000) { compose.onNodeWithText("PROMPT").fetchSemanticsNode().boundsInRoot.top < 150f }
        compose.onNodeWithText(menu.commitPrompt).assertIsDisplayed()
    }
}
