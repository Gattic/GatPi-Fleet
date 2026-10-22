import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { roadmapFixture } from "../scripts/roadmap-fixture.ts";
import { Reader } from "../src/dashboard/ui/overlays.ts";
import { roadmapText } from "../src/dashboard/ui/views/roadmap.ts";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { emptyUsage } from "../src/protocol/index.ts";
import { Sessions } from "../src/server/sessions.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("roadmap viewer shows nested paths, explicit statuses, notes and separate outcome/workflow counts", () => {
	const plan = roadmapFixture();
	const shown = roadmapText(plan, false);
	assert.match(shown, /Root outcomes: 0\/2 complete · 1 blocked/);
	assert.match(shown, /Workflow: 1\/4 complete · 1 blocked/);
	assert.match(shown, /@1\.1 \[active\] Build goals/);
	assert.match(shown, /#1\.1\.2 \[blocked\] Phone viewer\n\s+note: Waiting for dependency/);
	assert.match(roadmapText(undefined, false), /No roadmap published/);
	assert.match(roadmapText({ ...plan, viewer: undefined }, false), /Update GatPi-Harness and \/reload/);
	assert.match(roadmapText(plan, true), /Last known roadmap/);
	assert.match(roadmapText({ ...plan, lifecycle: "shelved" }, false), /Lifecycle: shelved/);
	const viewer = plan.viewer!;
	assert.match(roadmapText({ ...plan, viewer: { ...viewer, entries: [], totalEntries: 0 } }, false), /No roadmap items yet/);
	assert.match(roadmapText({ ...plan, viewer: { ...viewer, totalEntries: 1000 } }, false), /Showing first 5 of 1000 entries \(snapshot limit\)/);
	assert.match(roadmapText({ ...plan, viewer: { ...viewer, entries: [{ ...viewer.entries[0], status: "verified-unsubstantiated" }] } }, false), /\[verified-unsubstantiated\]/);
});

test("roadmap reader wraps Unicode and long text, scrolls to the end and preserves position on live changes", () => {
	const plan = roadmapFixture();
	const viewer = plan.viewer!;
	viewer.entries = Array.from({ length: 100 }, (_, i) => ({ kind: "item", path: String(i + 1), title: `Goal ${i + 1} 界 🧭 ${"long ".repeat(10)}`, status: "pending", notes: [] }));
	viewer.totalEntries = 100;
	let closed = false;
	const reader = new Reader({ title: "Roadmap Viewer", plain: true, keepPosition: true, text: () => roadmapText(plan, false), height: () => 15, keys: [["Esc", "close"]], onKey: () => { closed = true; } });
	for (const width of [20, 40, 80, 120]) {
		const lines = reader.render(width);
		assert.equal(lines.length, 15);
		for (const line of lines) assert(visibleWidth(line) <= width, `line exceeds ${width} columns`);
	}
	reader.handleInput("\x1b[F");
	assert.match(strip(reader.render(80).join("\n")), /Goal 100/);
	plan.complete++;
	assert.match(strip(reader.render(80).join("\n")), /Goal 100/, "a live update does not jump back to the title");
	reader.handleInput("\x1b[H");
	assert.match(strip(reader.render(80).join("\n")), /Root outcomes/);
	reader.handleInput("\x1b");
	assert.equal(closed, true);
});

test("reader titles strip terminal controls from session labels without adding terminal rows", () => {
	const reader = new Reader({ title: () => "session\x1b]52;c;c3ludGhldGlj\x07\nnext line", text: () => "synthetic data", height: () => 8, keys: [], onKey: () => {} });
	const lines = reader.render(80);
	assert.equal(lines.length, 8);
	for (const line of lines) {
		assert(!line.includes("\x1b]52;"), "session labels must not emit clipboard control sequences");
		assert(!line.includes("\n"), "session labels must not escape the header row");
		assert(!line.includes("\x07"));
	}
});

test("roadmap text strips terminal control sequences and never interprets task markup", () => {
	const plan = roadmapFixture();
	plan.viewer!.entries[0].title = "\x1b[31m**literal**\x1b[0m\x1b]52;c;bad\x07";
	plan.viewer!.entries[0].notes = ["\x1b[2Jnote\x00"];
	const output = roadmapText(plan, false);
	assert(!output.includes("\x1b"));
	assert(!output.includes("\x07"));
	assert.match(output, /\*\*literal\*\*/);
	assert.match(output, /note: note/);
});

test("selected roadmap projection matches Android's actual fixture, stays out of overview and is sanitized", () => {
	const runtime = new ManagerRuntime();
	const plan = roadmapFixture();
	runtime.store.setState(11, { pid: 11, instanceId: "incarnation", sessionId: "session", cwd: "/project", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [], plan });
	const sessions = new Sessions(runtime);
	const overview = sessions.overview()[0];
	assert(!("roadmap" in overview));
	assert(!JSON.stringify(overview).includes("Waiting for dependency"));
	const detail = sessions.detail(overview.id);
	assert.deepEqual(detail, JSON.parse(readFileSync(new URL("../api/fixtures/roadmap.json", import.meta.url), "utf8")));
	plan.viewer!.entries[0].notes = ["\x1b[31mred\x1b[0m\x00"];
	assert.deepEqual(sessions.detail(overview.id).roadmap?.entries[0].notes, ["red"]);
	// Paths are structural identifiers, not preview text: valid deeply nested
	// publisher paths must reach Android unchanged rather than ending in a dot.
	const deepPath = Array.from({ length: 91 }, () => "1").join(".");
	plan.viewer!.entries[0].path = deepPath;
	assert.equal(sessions.detail(overview.id).roadmap?.entries[0].path, deepPath);
	delete plan.viewer;
	assert.equal(sessions.detail(overview.id).roadmap, null, "missing detail is not an invented empty roadmap");
});
