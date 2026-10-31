package dev.pidash.android

internal fun matchingProjects(projects: List<Project>, filter: String): List<Project> {
    val query = filter.trim()
    return projects.filter { project ->
        listOfNotNull(project.label, project.path, project.host).any { it.contains(query, ignoreCase = true) }
    }
}
