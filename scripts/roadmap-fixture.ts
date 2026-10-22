// Synthetic nested plan shared by host projections, terminal checks and Android wire fixtures.
import type { PlanSnapshot } from "../src/protocol/index.ts";

export function roadmapFixture(): PlanSnapshot {
	return {
		title: "Ship the viewer 界 🧭", lifecycle: "active", complete: 1, total: 4, blocked: 1,
		milestones: [{ title: "Build", status: "active" }, { title: "Release", status: "pending" }],
		activePath: [{ title: "Build", status: "active", path: "1" }],
		viewer: {
			id: "roadmap-fixture", updatedAt: "2026-10-22T12:00:00.000Z",
			outcomes: { complete: 0, total: 2, blocked: 1 }, totalEntries: 5,
			entries: [
				{ kind: "item", path: "1", title: "Build", status: "active", notes: [] },
				{ kind: "roadmap", path: "1.1", title: "Build goals", status: "active", notes: [] },
				{ kind: "item", path: "1.1.1", title: "Terminal viewer", status: "done", notes: [] },
				{ kind: "item", path: "1.1.2", title: "Phone viewer", status: "blocked", notes: ["Waiting for dependency"] },
				{ kind: "item", path: "2", title: "Release", status: "pending", notes: [] },
			],
		},
	};
}
