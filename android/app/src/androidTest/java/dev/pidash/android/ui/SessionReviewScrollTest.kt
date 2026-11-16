package dev.pidash.android.ui

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
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
                // A small viewport: the composer starts below Chat's fold, so the review must bring it
                // into view rather than leave Chat at its top.
                Box(Modifier.height(300.dp)) {
                    SessionScreen(vm, Dashboard(detail = Detail(session, null, emptyList(), null, null, null,
                        emptyList(), emptyList(), emptyList()), epoch = "epoch", fresh = true), enabled = true)
                }
            }
        }

        compose.onNodeWithTag("prompt-field").assertIsNotDisplayed()
        compose.onNodeWithText("Manage").performClick()
        compose.onNodeWithText("Ask AI to review/commit").performScrollTo().performClick()

        // The draft is prepared in Chat, never sent; Chat opens on it.
        compose.onNodeWithText("Chat").assertIsSelected()
        compose.waitUntil(5_000) { runCatching { compose.onNodeWithText(menu.commitPrompt).assertIsDisplayed() }.isSuccess }
        compose.onNodeWithTag("prompt-field").assertIsDisplayed()
    }
}
