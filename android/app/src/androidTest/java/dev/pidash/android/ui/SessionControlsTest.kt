package dev.pidash.android.ui

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import dev.pidash.android.DashViewModel
import dev.pidash.android.Dashboard
import dev.pidash.android.Detail
import dev.pidash.android.DraftStorage
import dev.pidash.android.Drafts
import dev.pidash.android.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SessionControlsTest {
    @get:Rule val compose = createComposeRule()
    private val session = Session("s", "r", "project", "/work/project", "ready", "ready", null, null, true, null, null, null, null, null, null, null, mapOf("reload" to null, "new" to null, "restart" to null))

    @Test fun lifecycleButtonsConfirmTheTargetAndHonorHostAndConnectionGates() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val drafts = Drafts(object : DraftStorage {
            override fun read(): String? = null
            override fun save(document: String) = Unit
        }) { session.id }
        val vm = DashViewModel(app, drafts)
        val current = mutableStateOf(session)
        val enabled = mutableStateOf(true)
        compose.setContent {
            MaterialTheme { SessionScreen(vm, Dashboard(detail = Detail(current.value, null, emptyList(), null, null, null, emptyList(), emptyList(), emptyList())), enabled.value) }
        }
        for ((label, kind) in listOf("Reload" to "reload", "New session" to "new", "Restart" to "restart")) {
            compose.onNodeWithText(label).performScrollTo().assertIsEnabled().performClick()
            compose.runOnIdle {
                val confirmation = vm.confirmation.value!!
                assertEquals(session, confirmation.target)
                assertEquals(kind, confirmation.command!!.getString("kind"))
                assertTrue(confirmation.description.contains(session.project))
                assertTrue(confirmation.description.contains(when (kind) {
                    "restart" -> "same saved conversation"
                    "new" -> "fresh conversation in the same project"
                    else -> "without closing pi"
                }))
                vm.confirmation.value = null
            }
        }
        compose.runOnIdle { current.value = session.copy(commands = mapOf("reload" to "Only while idle", "new" to "Only while idle", "restart" to "Only while idle")) }
        for (label in listOf("Reload", "New session", "Restart")) compose.onNodeWithText(label).assertIsNotEnabled()
        compose.runOnIdle { current.value = session; enabled.value = false }
        for (label in listOf("Reload", "New session", "Restart")) compose.onNodeWithText(label).assertIsNotEnabled()
        compose.runOnIdle { current.value = session.copy(commands = emptyMap()); enabled.value = true }
        for (label in listOf("Reload", "New session", "Restart")) compose.onNodeWithText(label).assertIsNotEnabled()
    }
}
