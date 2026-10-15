package dev.pidash.android

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

enum class Screen { Sessions, Session, Projects, Usage, Glasses, Pairing }

data class Confirmation(val title: String, val description: String, val target: Session? = null, val command: JSONObject? = null, val project: Project? = null, val history: History? = null, val dismissReceipt: Boolean = false, val git: GitConfirmation? = null)

/** [drafts] are kept in the app's encrypted vault for the selected session; tests pass their own. */
class DashViewModel @JvmOverloads constructor(
    application: Application,
    val drafts: Drafts = (application as DashApp).let { app -> Drafts(VaultDraftStorage(app.vault)) { app.repository.state.value.selected } },
) : AndroidViewModel(application) {
    val app = application as DashApp
    val repository = app.repository
    val screen = MutableStateFlow(Screen.Sessions)
    val filter = MutableStateFlow("")
    val attentionOnly = MutableStateFlow(false)
    val ask = MutableStateFlow("")
    val delivery = MutableStateFlow("followUp")
    val confirmation = MutableStateFlow<Confirmation?>(null)
    /** The project choices fetched for this visit to Projects; null until they arrive. */
    val projects = MutableStateFlow<Projects?>(null)
    val history = MutableStateFlow<List<History>>(emptyList())
    val project = MutableStateFlow<Project?>(null)
    /** The report and its receipt-time anchor survive Activity recreation together. */
    val usage = MutableStateFlow<UsageSnapshot?>(null)
    val usageRange = MutableStateFlow(UsageReport.RANGES.first())
    val usageMetric = MutableStateFlow(Metric.Cost)
    val git = MutableStateFlow<GitView?>(null)
    private var gitVisit = 0
    val busy = MutableStateFlow(false)
    init {
        try { drafts.restore() } catch (_: Exception) { repository.message("Saved drafts unavailable; credentials may need re-pairing") }
    }
    fun select(session: Session) { closeGit(); repository.select(session.id); drafts.open(); ask.value = ""; screen.value = Screen.Session }
    /** Leaves session detail (or any other screen) for the overview, ending the detail subscription. */
    fun back() { closeGit(); screen.value = Screen.Sessions; repository.select(null) }
    fun resetDrafts() { drafts.clear(); ask.value = "" }
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
        val command = JSONObject().put("kind", "prompt").put("text", drafts.text.value)
        if (session.running) command.put("deliverAs", delivery.value)
        drafts.sent()
        run { repository.command(session, command) }
    }
    fun ask(session: Session) { run { repository.command(session, JSONObject().put("kind", "ask").put("question", ask.value)) } }
    /** Removes an exited session from the list, here and in pi-dash, then returns to the list. */
    fun dismiss(session: Session) { run { repository.command(session, JSONObject().put("kind", "dismiss")); back() } }
    fun confirm(session: Session, kind: String) {
        val (title, text) = when (kind) {
            "abort" -> "Abort run?" to "Abort the current run? This does not close pi."
            "shutdown" -> "Close session?" to "Close gracefully after the current run and queued messages finish? Abort is a separate action."
            "compact" -> "Compact context?" to "Summarise this session's context now using its model? Only available while idle."
            else -> error("Unsupported confirmation")
        }
        confirmation.value = Confirmation(title, "${session.label}\n${session.project}\n${session.statusLabel}\n\n$text", session, JSONObject().put("kind", kind))
    }
    fun confirmLaunch(p: Project, h: History?) { confirmation.value = Confirmation(if (h == null) "New session" else "Resume session", "${p.location}\n${h?.title ?: "Start a fresh pi session"}", project = p, history = h) }
    fun confirmed() {
        val c = confirmation.value ?: return
        confirmation.value = null
        run {
            when {
                c.dismissReceipt -> { repository.clearPending(); repository.message("Receipt dismissed after manual inspection; no command was replayed") }
                c.git != null -> { closeGit(); repository.gitAction(c.git) }
                c.target != null && c.command != null -> repository.command(c.target, c.command)
                c.project != null -> repository.launch(c.project, c.history)
            }
        }
    }
    fun closeGit() { gitVisit++; git.value = null; if (confirmation.value?.git != null) confirmation.value = null }
    fun openGit(session: Session) {
        if (busy.value) return
        closeGit()
        git.value = GitView(session.id)
        gitRead(session) { it.copy(menu = repository.git(session)) }
    }
    private fun gitRead(session: Session, read: suspend (GitView) -> GitView) {
        val visit = gitVisit
        val epoch = repository.state.value.epoch
        run {
            val current = git.value ?: return@run
            val result = try { read(current).copy(error = null) } catch (e: Exception) {
                if (e is CancellationException) throw e
                current.copy(error = e.message ?: "Git operation failed")
            }
            // A late response must not reopen a menu or populate a different session/gateway.
            if (visit == gitVisit && repository.state.value.selected == session.id && repository.state.value.epoch == epoch) git.value = result
        }
    }
    fun gitBranches(session: Session) = gitRead(session) { it.copy(branches = repository.gitBranches(session), status = null) }
    fun gitStatus(session: Session) = gitRead(session) { it.copy(status = repository.gitStatus(session), branches = null) }
    fun confirmGit(session: Session, kind: String, branch: String? = null) {
        val view = git.value?.takeIf { it.sessionId == session.id } ?: return
        val menu = view.menu ?: return
        val action = menu.actions.single { it.kind == kind }
        if (action.blocked != null) { repository.message(action.blocked); return }
        if (kind == "switch" && view.branches?.none { it.name == branch && !it.current } != false) return
        val text = if (kind == "switch") "Switch ${session.label} in ${menu.location} from ${menu.head} to $branch?${menu.warning}" else action.description!!
        confirmation.value = Confirmation("Git · ${action.label}", text, git = GitConfirmation(session, menu, kind, branch))
    }
    fun gitCommitPrompt(session: Session) {
        val menu = git.value?.takeIf { it.sessionId == session.id }?.menu ?: return
        drafts.edit(menu.commitPrompt)
        delivery.value = if (session.running) "followUp" else "steer"
        closeGit()
        repository.message("Review the draft in Prompt below, then Send prompt. Nothing has been sent.")
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
    fun openUsage() {
        screen.value = Screen.Usage
        // An earlier visit's report may be long outdated, or another host's after re-pairing.
        usage.value = null
        refreshUsage()
    }
    fun refreshUsage() { run {
        val report = repository.usage()
        usage.value = UsageSnapshot(report, SystemClock.elapsedRealtime())
    } }
    /** Expands one project's resumable history in place; selecting it again collapses it. */
    fun history(p: Project) {
        if (project.value == p) { project.value = null; return }
        project.value = p
        history.value = emptyList()
        run { history.value = repository.history(p) }
    }
}
