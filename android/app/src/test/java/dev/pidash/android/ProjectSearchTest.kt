package dev.pidash.android

import org.junit.Assert.assertEquals
import org.junit.Test

class ProjectSearchTest {
    private val first = Project("a", null, "Alpha", "/work/client")
    private val second = Project("b", "build-box", "Beta", "/srv/backend")
    private val third = Project("c", "other-box", "Gamma", "/srv/client")
    private val projects = listOf(first, second, third)

    @Test fun matchesNamePathAndHostIgnoringCaseAndSurroundingSpaces() {
        assertEquals(listOf(first), matchingProjects(projects, " ALPHA "))
        assertEquals(listOf(first, third), matchingProjects(projects, "CLIENT"))
        assertEquals(listOf(second), matchingProjects(projects, "Build-BOX"))
    }

    @Test fun clearingRestoresTheOriginalHostOrderAndNoMatchIsEmpty() {
        assertEquals(projects, matchingProjects(projects, ""))
        assertEquals(projects, matchingProjects(projects, "   "))
        assertEquals(emptyList<Project>(), matchingProjects(projects, "absent"))
        assertEquals(listOf(second, third), matchingProjects(projects, "box"))
        assertEquals(emptyList<Project>(), matchingProjects(emptyList(), "alpha"))
    }
}
