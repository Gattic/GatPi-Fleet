package dev.pidash.android

import org.json.JSONObject

data class GitAction(val kind: String, val label: String, val blocked: String?, val description: String?)
data class GitBranch(val name: String, val current: Boolean, val upstream: String?)
data class GitMenu(
    val epoch: String, val revision: String, val location: String, val head: String, val branch: String?,
    val upstream: String?, val ahead: Int, val behind: Int, val tree: String, val warning: String,
    val commitPrompt: String, val actions: List<GitAction>,
) {
    companion object {
        fun parse(j: JSONObject) = GitMenu(
            j.getString("epoch"), j.getString("revision"), j.getString("location"), j.getString("head"), j.text("branch"),
            j.text("upstream"), j.getInt("ahead"), j.getInt("behind"), j.getString("tree"), j.getString("warning"), j.getString("commitPrompt"),
            j.getJSONArray("actions").objects().map { GitAction(it.getString("kind"), it.getString("label"), it.text("blocked"), it.text("description")) },
        )
    }
}

data class GitView(
    val sessionId: String, val menu: GitMenu? = null, val branches: List<GitBranch>? = null,
    val status: String? = null, val error: String? = null,
)
data class GitConfirmation(val session: Session, val menu: GitMenu, val kind: String, val branch: String? = null) {
    fun action(): JSONObject = JSONObject().put("kind", kind).also { j -> branch?.let { j.put("branch", it) } }
}
