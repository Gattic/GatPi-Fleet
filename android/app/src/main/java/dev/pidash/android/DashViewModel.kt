package dev.pidash.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

enum class Screen { Sessions, Session, Projects, Glasses, Pairing }

data class Confirmation(val title: String, val description: String, val target: Session? = null, val command: JSONObject? = null, val project: Project? = null, val history: History? = null, val dismissReceipt: Boolean = false)

class DashViewModel(application: Application) : AndroidViewModel(application) {
    val app = application as DashApp
    val repository = app.repository
    val screen = MutableStateFlow(Screen.Sessions)
    val filter = MutableStateFlow("")
    val attentionOnly = MutableStateFlow(false)
    val draft = MutableStateFlow("")
    val ask = MutableStateFlow("")
    val delivery = MutableStateFlow("followUp")
    val confirmation = MutableStateFlow<Confirmation?>(null)
    /** The project choices fetched for this visit to Projects; null until they arrive. */
    val projects = MutableStateFlow<List<Project>?>(null)
    val history = MutableStateFlow<List<History>>(emptyList())
    val project = MutableStateFlow<Project?>(null)
    val busy = MutableStateFlow(false)
    private val drafts = linkedMapOf<String, String>()
    init {
        try {
            app.vault.read("drafts")?.let { text -> val json = JSONObject(text); json.keys().forEach { drafts[it] = json.getString(it).take(32_000) } }
        } catch (_: Exception) { repository.message("Saved drafts unavailable; credentials may need re-pairing") }
    }
    fun select(session: Session) { repository.select(session.id); draft.value = drafts[session.id].orEmpty(); ask.value = ""; screen.value = Screen.Session }
    /** Leaves session detail (or any other screen) for the overview, ending the detail subscription. */
    fun back() { screen.value = Screen.Sessions; repository.select(null) }
    fun draft(value: String) {
        draft.value = value.take(32_000)
        val id = repository.state.value.selected ?: return
        drafts.remove(id); drafts[id] = draft.value
        while (drafts.size > 3) drafts.remove(drafts.keys.first())
        app.vault.save("drafts", JSONObject(drafts.toMap()).toString())
    }
    fun resetDrafts() { drafts.clear(); draft.value = ""; ask.value = "" }
    fun run(action: suspend () -> Unit) {
        if (busy.value) return
        viewModelScope.launch {
            busy.value = true
            try { action() } catch (e: Exception) {
                if (e is CancellationException) throw e
                repository.message(e.message ?: "Operation failed")
            } finally { busy.value = false }
        }
    }
    fun prompt(session: Session) {
        val command = JSONObject().put("kind", "prompt").put("text", draft.value)
        if (session.running) command.put("deliverAs", delivery.value)
        run { repository.command(session, command) }
    }
    fun ask(session: Session) { run { repository.command(session, JSONObject().put("kind", "ask").put("question", ask.value)) } }
    fun confirm(session: Session, kind: String) {
        val (title, text) = when (kind) {
            "abort" -> "Abort run?" to "Abort the current run? This does not close pi."
            "shutdown" -> "Close session?" to "Close gracefully after the current run and queued messages finish? Abort is a separate action."
            "compact" -> "Compact context?" to "Summarise this session's context now using its model? Only available while idle."
            else -> error("Unsupported confirmation")
        }
        confirmation.value = Confirmation(title, "${session.label}\n${session.project}\n${session.statusLabel}\n\n$text", session, JSONObject().put("kind", kind))
    }
    fun confirmLaunch(p: Project, h: History?) { confirmation.value = Confirmation(if (h == null) "New session" else "Resume session", "${p.path}\n${h?.title ?: "Start a fresh pi session"}", project = p, history = h) }
    fun confirmed() {
        val c = confirmation.value ?: return
        confirmation.value = null
        run {
            when {
                c.dismissReceipt -> { repository.clearPending(); repository.message("Receipt dismissed after manual inspection; no command was replayed") }
                c.target != null && c.command != null -> repository.command(c.target, c.command)
                c.project != null -> repository.launch(c.project, c.history)
            }
        }
    }
    fun openProjects() {
        screen.value = Screen.Projects
        // An earlier visit's list may be in an outdated order, and replacing it when the fetch answers
        // would move rows under the user's finger. Show nothing until this visit's list arrives.
        projects.value = null
        project.value = null
        history.value = emptyList()
        run { projects.value = repository.projects() }
    }
    /** Expands one project's resumable history in place; selecting it again collapses it. */
    fun history(p: Project) {
        if (project.value == p) { project.value = null; return }
        project.value = p
        history.value = emptyList()
        run { history.value = repository.history(p) }
    }
}
