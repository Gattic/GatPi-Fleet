import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, applyPatch, emptyUsage, LineDecoder, type SessionState } from "../src/protocol/index.ts";

test("LineDecoder reassembles messages split across chunks", () => {
	const decoder = new LineDecoder();
	assert.deepEqual(decoder.push('{"type":"hel'), []);
	assert.deepEqual(decoder.push('lo","version":1}\n{"a":'), [{ type: "hello", version: 1 }]);
	assert.deepEqual(decoder.push("2}\n\n"), [{ a: 2 }]);
});

test("LineDecoder splits on LF only, keeping Unicode line separators inside strings", () => {
	const decoder = new LineDecoder();
	const text = "line\u2028separated\u2029paragraph";
	assert.deepEqual(decoder.push(`${JSON.stringify({ text })}\n`), [{ text }]);
});

test("addUsage matches pi's /session token total", () => {
	const totals = emptyUsage();
	addUsage(totals, { input: 2, output: 287, cacheRead: 331042, cacheWrite: 860, cost: { total: 0.0762564 } });
	addUsage(totals, { input: 10, output: 5 });
	assert.equal(totals.tokens, 2 + 287 + 331042 + 860 + 15);
	assert.equal(totals.cost, 0.0762564);
});

test("applyPatch replaces fields and null clears them", () => {
	const state = { pid: 1, phase: "working", activity: { kind: "tool", since: 1 }, lastPrompt: "x" } as unknown as SessionState;
	const next = applyPatch(state, { phase: "idle", activity: null });
	assert.equal(next.phase, "idle");
	assert.equal("activity" in next, false);
	assert.equal(next.lastPrompt, "x");
	assert.equal(state.phase, "working", "patching does not mutate the previous state");
});
