// Read-only text for the session Roadmap Viewer; never renders task text as Markdown or terminal controls.
import { stripVTControlCharacters } from "node:util";
import type { PlanSnapshot } from "../../../protocol/index.ts";

const text = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function roadmapText(plan: PlanSnapshot | undefined, stale: boolean): string {
	const lines = [stale ? "Last known roadmap · session disconnected or exited" : "Live roadmap · read-only"];
	if (!plan) return [...lines, "", "No roadmap published for this session."].join("\n");
	lines.push(text(plan.title), `Lifecycle: ${text(plan.lifecycle)}`);
	const viewer = plan.viewer;
	if (!viewer) return [...lines, "", "Nested roadmap detail unavailable. Update GatPi-Harness and /reload the session."].join("\n");
	lines.push(
		`Root outcomes: ${viewer.outcomes.complete}/${viewer.outcomes.total} complete · ${viewer.outcomes.blocked} blocked`,
		`Workflow: ${plan.complete}/${plan.total} complete · ${plan.blocked} blocked`,
		`Updated: ${text(viewer.updatedAt)}`,
	);
	if (plan.activePath.length) lines.push(`Active: ${plan.activePath.map((step) => `${text(step.path ?? "")} ${text(step.title)}`).join(" › ")}`);
	if (viewer.entries.length < viewer.totalEntries) lines.push(`Showing first ${viewer.entries.length} of ${viewer.totalEntries} entries (snapshot limit).`);
	lines.push("");
	for (const entry of viewer.entries) {
		const indent = "  ".repeat(Math.min(12, entry.path.split(".").length - 1));
		lines.push(`${indent}${entry.kind === "roadmap" ? "@" : "#"}${text(entry.path)} [${text(entry.status)}] ${text(entry.title)}`);
		for (const note of entry.notes) lines.push(`${indent}  note: ${text(note)}`);
	}
	if (!viewer.totalEntries) lines.push("No roadmap items yet.");
	return lines.join("\n");
}
