import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type FileMeta, scanBuffer, type UsageRecord } from "../src/manager/usage/extract.ts";
import { UsageIndexer } from "../src/manager/usage/indexer.ts";
import { UsageIndex } from "../src/manager/usage/usage-index.ts";

const T0 = Date.parse("2026-10-03T10:00:00.000Z");

function usage(input: number, output: number, cacheRead: number, cost: number) {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

function sessionLines(id: string, cwd: string, start: number): string[] {
	return [
		{ type: "session", version: 3, id, timestamp: new Date(start).toISOString(), cwd },
		{ type: "message", id: "u1", parentId: null, timestamp: new Date(start + 1000).toISOString(), message: { role: "user", content: [{ type: "text", text: "Fix the  login\nbug" }], timestamp: start + 1000 } },
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: new Date(start + 2000).toISOString(),
			// Tool-call arguments containing "usage" and "model" keys must not confuse extraction.
			message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { content: '{"usage":{"input":999},"model":"fake"}' } }], api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", usage: usage(100, 50, 1000, 0.5), stopReason: "toolUse", timestamp: start + 2000 },
		},
		{ type: "message", id: "t1", parentId: "a1", timestamp: new Date(start + 3000).toISOString(), message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "ok" }], details: { usage: { input: 1 } }, isError: false, timestamp: start + 3000 } },
		{ type: "message", id: "t2", parentId: "t1", timestamp: new Date(start + 3500).toISOString(), message: { role: "toolResult", toolCallId: "c2", toolName: "ask", content: [], usage: usage(10, 5, 0, 0.05), isError: false, timestamp: start + 3500 } },
		{ type: "compaction", id: "c1", parentId: "t2", timestamp: new Date(start + 4000).toISOString(), summary: "s", firstKeptEntryId: "a1", tokensBefore: 5, usage: usage(20, 10, 0, 0.1) },
		{ type: "session_info", id: "i1", parentId: "c1", timestamp: new Date(start + 5000).toISOString(), name: "login fix" },
	].map((entry) => JSON.stringify(entry));
}

test("scanBuffer extracts usage like pi's /session and ignores look-alike keys", () => {
	const meta: FileMeta = {};
	const records: UsageRecord[] = [];
	const data = Buffer.from(`${sessionLines("s1", "/proj", T0).join("\n")}\n{"type":"message","partial`);
	const consumed = scanBuffer(data, meta, records);
	assert.equal(data.subarray(consumed).toString(), '{"type":"message","partial', "incomplete trailing line is left for the next read");
	assert.deepEqual(
		records.map((record) => [record.model, record.tokens, record.cost]),
		[
			["anthropic/claude-opus-5-5", 1150, 0.5],
			["(tool)", 15, 0.05],
			["(summary)", 30, 0.1],
		],
	);
	assert.deepEqual(meta, { sessionId: "s1", cwd: "/proj", name: "login fix", firstPrompt: "Fix the login bug" });
});

test("UsageIndexer indexes incrementally, handles rewrites, and enforces retention", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-usage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sessions = join(root, "sessions");
	const dir = join(sessions, "--proj--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "s1.jsonl");
	const lines = sessionLines("s1", "/proj", T0);
	// Retention compares file mtimes with the scan's `now`, so each write is dated on this test's clock.
	const writtenAt = (at: number) => utimesSync(file, new Date(at), new Date(at));
	writeFileSync(file, `${lines.slice(0, 3).join("\n")}\n`);
	writtenAt(T0 + 2000);
	const cache = join(root, "cache.json");
	const request = { type: "scan" as const, sessionRoot: sessions, subagentCwds: [], retentionMs: 30 * 86_400_000 };
	const now = T0 + 10_000;

	const indexer = new UsageIndexer(cache);
	assert.equal(indexer.scan(request, now).changed.length, 1);
	const tokens = () => Object.values(indexer.files.get(file)?.hours ?? {}).flatMap((models) => Object.values(models)).reduce((sum, bucket) => sum + bucket.tokens, 0);
	assert.equal(tokens(), 1150);

	appendFileSync(file, `${lines.slice(3).join("\n")}\n`);
	writtenAt(T0 + 5000);
	indexer.scan(request, now);
	assert.equal(tokens(), 1195, "appended lines are added without re-reading");
	assert.equal(indexer.scan(request, now).changed.length, 0, "unchanged files are skipped");
	indexer.save();

	const reloaded = new UsageIndexer(cache);
	reloaded.load();
	assert.equal(reloaded.scan(request, now).changed.length, 0, "cache survives restarts");

	// pi may rewrite a file (e.g. migrating its format); offsets no longer line up.
	writeFileSync(file, `${lines.slice(0, 1).join("\n")}\n${lines.slice(2, 3).join("\n").replace('"input":100', '"input":200')}\n${"x".repeat(5)}\n`);
	writtenAt(T0 + 6000);
	reloaded.scan(request, now);
	const reindexed = Object.values(reloaded.files.get(file)?.hours ?? {}).flatMap((models) => Object.values(models)).reduce((sum, bucket) => sum + bucket.tokens, 0);
	assert.equal(reindexed, 1250, "a rewritten file is re-indexed from the start");

	const later = T0 + 31 * 86_400_000;
	const expired = reloaded.scan(request, later);
	assert.deepEqual(expired.removed, [file], "files older than the retention window are dropped");
});

test("UsageIndex folds subagent usage into the parent session", () => {
	const index = new UsageIndex({ sessionRoot: "", cachePath: "", retentionMs: 0, onUpdate: () => {} });
	const hour = String(Math.floor(T0 / 3_600_000));
	const bucket = (cost: number) => ({ tokens: cost * 1000, cost, cacheRead: 0, prompt: 0 });
	index.apply({
		type: "update",
		scanned: true,
		durationMs: 0,
		removed: [],
		changed: [
			{ path: "/a.jsonl", kind: "session", sessionId: "parent", cwd: "/p", size: 1, mtimeMs: 1, offset: 1, hours: { [hour]: { "anthropic/opus": bucket(2) } } },
			{ path: "/sub.jsonl", kind: "subagent", sessionId: "child", parentSessionId: "parent", size: 1, mtimeMs: 1, offset: 1, hours: { [hour]: { "anthropic/opus": bucket(1), "openai-codex/gpt": bucket(0.5) } } },
		],
	});
	const owners = index.byOwner(T0 - 1);
	assert.equal(owners.size, 1);
	assert.equal(owners.get("parent")?.usage.cost, 3.5);
	assert.equal(index.byOwner(T0 - 1, "anthropic").get("parent")?.usage.cost, 3, "provider filter keeps only that provider's models");
	assert.equal(index.subagentUsage("parent").cost, 1.5);
	assert.deepEqual(index.series(T0, T0 + 3_600_000, 1, "cost"), [3.5, 0]);
});
