package dev.pidash.android

import org.json.JSONObject

data class RoadmapEntry(val kind: String, val path: String, val title: String, val status: String, val notes: List<String>) {
    val label: String get() = "${if (kind == "roadmap") "@" else "#"}$path"
    val depth: Int get() = path.count { it == '.' }
}

data class Roadmap(
    val id: String, val title: String, val lifecycle: String, val updatedAt: String,
    val complete: Int, val total: Int, val blocked: Int,
    val outcomesComplete: Int, val outcomesTotal: Int, val outcomesBlocked: Int,
    val entries: List<RoadmapEntry>, val totalEntries: Int,
) {
    val limited: Boolean get() = entries.size < totalEntries
    companion object {
        fun parse(j: JSONObject): Roadmap {
            val outcomes = j.getJSONObject("outcomes")
            val entries = j.getJSONArray("entries").objects().map {
                val kind = it.getString("kind")
                require(kind in listOf("item", "roadmap")) { "Unsupported roadmap entry" }
                val path = it.getString("path")
                require(Regex("[1-9][0-9]*(\\.[1-9][0-9]*)*").matches(path)) { "Invalid roadmap path" }
                RoadmapEntry(kind, path, it.getString("title"), it.getString("status"),
                    it.getJSONArray("notes").let { notes -> (0 until notes.length()).map(notes::getString) })
            }
            val totalEntries = j.getInt("totalEntries")
            require(totalEntries >= entries.size) { "Invalid roadmap entry count" }
            return Roadmap(j.getString("id"), j.getString("title"), j.getString("lifecycle"), j.getString("updatedAt"),
                j.getInt("complete"), j.getInt("total"), j.getInt("blocked"),
                outcomes.getInt("complete"), outcomes.getInt("total"), outcomes.getInt("blocked"), entries, totalEntries)
        }
    }
}
