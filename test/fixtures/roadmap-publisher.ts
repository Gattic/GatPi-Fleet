// Test-only extension standing in for the GatPi-Harness roadmap: publishes a plan
// snapshot on the extension bus at session start, like the real roadmap does.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function roadmapPublisher(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.events.emit("roadmap:changed", {
			title: "E2E plan",
			lifecycle: "active",
			complete: 1,
			total: 3,
			blocked: 0,
			milestones: [
				{ title: "One", status: "done" },
				{ title: "Two", status: "active" },
			],
			activePath: [{ title: "Two", status: "active", path: "2" }],
		});
	});
}
