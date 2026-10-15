package dev.pidash.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GitTest {
    @Test fun readsTheSharedHostMenuIncludingGuardsWarningsAndEditablePrompt() {
        val menu = GitMenu.parse(JSONObject(javaClass.classLoader!!.getResource("git.json")!!.readText()))
        assertEquals("box:/project", menu.location)
        assertEquals("main", menu.branch)
        assertEquals("origin/main", menu.upstream)
        assertEquals(2, menu.ahead)
        assertEquals(1, menu.behind)
        assertEquals("1 staged, 2 changed, 3 untracked", menu.tree)
        assertTrue(menu.warning.contains("project@box is working"))
        assertEquals(listOf("pull", "push", "switch"), menu.actions.map { it.kind })
        assertNull(menu.actions[0].blocked)
        assertTrue(menu.actions[0].description!!.contains("pull --ff-only"))
        assertTrue(menu.actions[1].description!!.contains("publish main (2 ahead) to origin/main"))
        assertTrue(menu.actions[2].blocked!!.contains("Working tree has changes"))
        assertTrue(menu.commitPrompt.endsWith("Do not push."))
        val session = reduceFrame(Dashboard(), JSONObject(javaClass.classLoader!!.getResource("snapshot.json")!!.readText()), 1).sessions.single()
        val action = GitConfirmation(session, menu, "switch", "feature/topic").action()
        assertEquals(setOf("kind", "branch"), action.keys().asSequence().toSet())
        assertEquals("feature/topic", action.getString("branch"))
        assertFalse(GitConfirmation(session, menu, "pull").action().has("branch"))
    }
}
