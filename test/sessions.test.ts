import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listProjects, listSessions, sessionDirName } from "../src/manager/actions/sessions.ts";
import { UsageIndex } from "../src/manager/usage/usage-index.ts";

const noIndex = () => new UsageIndex({ sessionRoot: "", cachePath: "", retentionMs: 0, onUpdate: () => {} });

function writeSession(dir: string, name: string, cwd: string, entries: object[]): string {
	const path = join(dir, name);
	const header = { type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd };
	writeFileSync(path, [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	return path;
}

test("a session that opens with a system prompt larger than any head chunk is still listed by its first prompt", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-sessions-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "project");
	mkdirSync(project);
	const dir = join(root, "sessions", sessionDirName(project));
	mkdirSync(dir, { recursive: true });
	const at = new Date().toISOString();
	const system = { type: "message", id: "s", parentId: null, timestamp: at, message: { role: "system", content: "x".repeat(200 * 1024) } };
	const user = { type: "message", id: "u", parentId: "s", timestamp: at, message: { role: "user", content: [{ type: "text", text: "Install Redis here" }] } };
	const path = writeSession(dir, "big-system.jsonl", project, [system, user]);
	writeSession(dir, "small.jsonl", project, [{ ...user, message: { role: "user", content: "Say hello" } }]);
	writeSession(dir, "no-prompt.jsonl", project, [system]);

	const sessions = listSessions(join(root, "sessions"), project, noIndex());
	assert.equal(sessions.find((session) => session.path === path)?.title, "Install Redis here");
	assert.deepEqual(sessions.map((session) => session.title).sort(), ["(empty session)", "Install Redis here", "Say hello"]);
	assert.deepEqual(listProjects(join(root, "sessions"), []).map((entry) => [entry.cwd, entry.sessions]), [[project, 3]]);
});
