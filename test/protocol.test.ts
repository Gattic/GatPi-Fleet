import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, applyPatch, diffState, emptyUsage, LineDecoder, type SessionState } from "../src/protocol/index.ts";

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

test("a nested context breakdown survives the patch round-trip", () => {
	const breakdown = {
		parts: { system: 100, tools: 200, injected: 0, user: 30, assistant: 40, toolResults: 50, summary: 0 },
		unattributed: -20,
		totalBasis: "measured" as const,
		imageTokens: 0,
		counts: { user: 1, assistant: 1, toolResults: 1, injected: 0, imageBlocks: 0 },
		compactAt: 183_616,
		history: [100, 200],
		at: 5,
	};
	const previous = { pid: 1, phase: "idle" } as unknown as SessionState;
	const next = { pid: 1, phase: "idle", context: { tokens: 420, window: 200_000, percent: 0.21, breakdown } } as unknown as SessionState;
	const patched = applyPatch(previous, diffState(previous, next));
	assert.deepEqual(patched.context, next.context);
});
