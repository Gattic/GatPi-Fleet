package dev.pidash.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import dev.pidash.android.Detail
import dev.pidash.android.Session
import dev.pidash.android.Tool
import org.junit.Rule
import org.junit.Test

/** Reading UI only: synthetic data, no pairing, host request or command. */
class SessionOutputTest {
    @get:Rule val compose = createComposeRule()

    private fun session() = Session("s", "r", "project", "/project", "idle", "idle", null, null, true,
        null, null, null, null, null, null, null, mapOf("prompt" to null))

    private val reply = """
        # Findings

        **bold** and `code`.

        ```sh
        echo hi
        ```

        - one
        - two
    """.trimIndent()

    @Test fun replyRendersMarkdownTogglesToPlainTextAndMaximizes() {
        val detail = Detail(session(), "prompt", emptyList(), reply, null, null, emptyList(), emptyList(), emptyList())
        compose.setContent { PiDashTheme { Box(Modifier.width(320.dp)) { ExchangeCard(detail) } } }

        compose.onNodeWithText("Findings").assertIsDisplayed()
        compose.onNodeWithText("bold", substring = true).assertIsDisplayed()
        compose.onNodeWithText("echo hi").assertIsDisplayed()

        compose.onNodeWithText("Plain text").performClick()
        compose.onNodeWithTag("reply-plain").assertTextContains("# Findings", substring = true)
        compose.onNodeWithText("Markdown").performClick()
        compose.onNodeWithText("Findings").assertIsDisplayed()

        compose.onNodeWithText("Maximize").performClick()
        compose.onNodeWithText("Model output").assertIsDisplayed()
        compose.onNodeWithTag("reply-viewer").assertIsDisplayed()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithText("Model output").assertDoesNotExist()
    }

    @Test fun aRunningReplyCannotBeMaximized() {
        val detail = Detail(session(), "prompt", emptyList(), null, null, null, emptyList(), emptyList(), emptyList())
        compose.setContent { PiDashTheme { Box(Modifier.width(320.dp)) { ExchangeCard(detail) } } }
        compose.onNodeWithText("No completed reply").assertIsDisplayed()
        compose.onNodeWithText("Maximize").assertIsNotEnabled()
    }

    @Test fun toolRowsShowArgumentsAndOutputOnlyWhenExpanded() {
        val tools = listOf(
            Tool("bash", "npm test", "{\"command\":\"npm test\"}", "all green", 1000L, 2500L, false),
            Tool("read", "README.md", null, null, 3000L, null, false),
        )
        compose.setContent { PiDashTheme { Box(Modifier.width(320.dp)) { ToolsCard(tools) } } }

        compose.onNodeWithText("finished in 1.5s").assertIsDisplayed()
        compose.onNodeWithText("running").assertIsDisplayed()
        compose.onNodeWithText("{\"command\":\"npm test\"}").assertDoesNotExist()

        compose.onNodeWithTag("tool-bash").performClick()
        compose.onNodeWithText("Arguments").assertIsDisplayed()
        compose.onNodeWithText("{\"command\":\"npm test\"}").assertIsDisplayed()
        compose.onNodeWithText("Output").assertIsDisplayed()
        compose.onNodeWithText("all green").assertIsDisplayed()

        compose.onNodeWithTag("tool-read").performClick()
        compose.onNodeWithText("Running; output appears when the tool finishes.").assertIsDisplayed()
    }

    @Test fun aFailedToolShowsItsErrorOutput() {
        val failed = listOf(Tool("bash", "npm test", "{}", "exit 1", 1000L, 2000L, true))
        compose.setContent { PiDashTheme { Box(Modifier.width(320.dp)) { ToolsCard(failed) } } }
        compose.onNodeWithText("failed").assertIsDisplayed()
        compose.onNodeWithTag("tool-bash").performClick()
        compose.onNodeWithText("Error output").assertIsDisplayed()
        compose.onNodeWithText("exit 1").assertIsDisplayed()
    }

    @Test fun aHostThatDoesNotSendToolDetailsSaysSo() {
        val oldHost = listOf(Tool("read", "README.md", null, null, 1000L, 2000L, false))
        compose.setContent { PiDashTheme { Box(Modifier.width(320.dp)) { ToolsCard(oldHost) } } }
        compose.onNodeWithText("This host does not send tool arguments or output", substring = true).assertIsDisplayed()
    }
}
