import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { computeContextBreakdown, contextHistory, HISTORY_LIMIT } from "../src/bridge/context.ts";

type AgentMessage = Parameters<typeof estimateTokens>[0];
type SystemMessage = Extract<AgentMessage, { role: "system" }>;

const at = 1;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function system(text: string, tools: string[] = []): SystemMessage {
	return {
		role: "system",
		content: text,
		toolsAdded: tools.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } })),
		timestamp: at,
	};
}

function user(text: string, images = 0): AgentMessage {
	const content: Extract<AgentMessage, { role: "user" }>["content"] = [{ type: "text", text }];
	for (let i = 0; i < images; i++) content.push({ type: "image", data: "x", mimeType: "image/png" });
	return { role: "user", content, timestamp: at };
}

function assistant(text: string, tokens = 0): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: { ...usage, totalTokens: tokens },
		stopReason: "stop",
		timestamp: at,
	};
}

function toolResult(text: string): AgentMessage {
	return { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: at };
}

function injected(text: string): AgentMessage {
	return { role: "custom", customType: "note", content: text, display: true, timestamp: at };
}

function summary(text: string): AgentMessage {
	return { role: "compactionSummary", summary: text, tokensBefore: 100, timestamp: at };
}

function bash(command: string, output: string): AgentMessage {
	return { role: "bashExecution", command, output, exitCode: 0, cancelled: false, truncated: false, timestamp: at };
}

let seq = 0;
function messageEntry(message: AgentMessage): SessionEntry {
	return { type: "message", id: String(seq++), parentId: null, timestamp: new Date(0).toISOString(), message };
}

test("splits the leading system message into prompt and tool declarations", () => {
	const message = system("You are a careful assistant.", ["bash", "read"]);
	const breakdown = computeContextBreakdown({ system: message, messages: [], usage: undefined, now: at });
	assert.ok(breakdown.parts.tools > 0);
	assert.equal(breakdown.parts.tools, estimateTokens(message) - estimateTokens({ ...message, toolsAdded: undefined }));
	assert.equal(breakdown.parts.system + breakdown.parts.tools, estimateTokens(message));
});

test("buckets projected messages by role and counts them", () => {
	const messages = [user("hello"), assistant("hi"), toolResult("out"), injected("note"), summary("summary"), bash("ls", "files")];
	const breakdown = computeContextBreakdown({ messages, usage: undefined, now: at });
	assert.equal(breakdown.parts.user, estimateTokens(messages[0]));
	assert.equal(breakdown.parts.assistant, estimateTokens(messages[1]));
	assert.equal(breakdown.parts.toolResults, estimateTokens(messages[2]) + estimateTokens(messages[5]));
	assert.equal(breakdown.parts.injected, estimateTokens(messages[3]));
	assert.equal(breakdown.parts.summary, estimateTokens(messages[4]));
	assert.equal(breakdown.parts.system, 0);
	assert.deepEqual(breakdown.counts, { user: 1, assistant: 1, toolResults: 2, injected: 1, imageBlocks: 0 });
});

test("unattributed is the measured total minus the estimates and may be negative", () => {
	const breakdown = computeContextBreakdown({
		system: system("x".repeat(400)),
		messages: [user("y".repeat(400))],
		usage: { tokens: 10, window: 200_000, percent: 0 },
		now: at,
	});
	assert.equal(breakdown.totalBasis, "measured");
	assert.ok(breakdown.unattributed !== null && breakdown.unattributed < 0);
});

test("an unknown total stays unknown instead of becoming zero", () => {
	const breakdown = computeContextBreakdown({ messages: [user("hello")], usage: { tokens: null, window: 200_000, percent: null }, now: at });
	assert.equal(breakdown.unattributed, null);
	assert.equal(breakdown.totalBasis, "estimate");
	assert.ok(breakdown.parts.user > 0);
});

test("compactAt follows the window and reserve, and disappears when compaction is off", () => {
	const usage = { tokens: 0, window: 200_000, percent: 0 };
	assert.equal(computeContextBreakdown({ messages: [], usage, compaction: { enabled: true, reserveTokens: 16_384 }, now: at }).compactAt, 183_616);
	assert.equal(computeContextBreakdown({ messages: [], usage, compaction: { enabled: false, reserveTokens: 16_384 }, now: at }).compactAt, null);
	assert.equal(computeContextBreakdown({ messages: [], usage, now: at }).compactAt, 200_000 - 16_384, "pi's default reserve applies");
	assert.equal(computeContextBreakdown({ messages: [], now: at }).compactAt, null, "no window means no threshold");
});

test("context history keeps the latest requests, oldest first", () => {
	const entries: SessionEntry[] = [];
	for (let i = 1; i <= HISTORY_LIMIT + 3; i++) entries.push(messageEntry(assistant("x", i)));
	entries.push(messageEntry(assistant("x", 0)), { type: "model_change", id: "m", parentId: null, timestamp: new Date(0).toISOString(), provider: "p", modelId: "m" });
	const history = contextHistory(entries);
	assert.equal(history.length, HISTORY_LIMIT);
	assert.equal(history[0], 4);
	assert.equal(history.at(-1), HISTORY_LIMIT + 3);
});

test("history input is bounded as well", () => {
	const breakdown = computeContextBreakdown({ messages: [], history: Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => i), now: at });
	assert.deepEqual(breakdown.history, Array.from({ length: HISTORY_LIMIT }, (_, i) => i + 5));
});

test("images are counted where they are estimated and reported separately", () => {
	const message = user("look", 2);
	const breakdown = computeContextBreakdown({ messages: [message], usage: undefined, now: at });
	assert.equal(breakdown.counts.imageBlocks, 2);
	assert.equal(breakdown.imageTokens, 2 * Math.ceil(4800 / 4));
	assert.equal(breakdown.parts.user, estimateTokens(message));
	assert.equal(estimateTokens(message), Math.ceil(("look".length + 2 * 4800) / 4));
});

test("an empty projection still yields a complete, zeroed breakdown", () => {
	const breakdown = computeContextBreakdown({ messages: [], now: at });
	assert.deepEqual(breakdown.parts, { system: 0, tools: 0, injected: 0, user: 0, assistant: 0, toolResults: 0, summary: 0 });
	assert.equal(breakdown.unattributed, null);
	assert.equal(breakdown.totalBasis, "estimate");
	assert.equal(breakdown.imageTokens, 0);
	assert.deepEqual(breakdown.counts, { user: 0, assistant: 0, toolResults: 0, injected: 0, imageBlocks: 0 });
	assert.equal(breakdown.compactAt, null);
	assert.deepEqual(breakdown.history, []);
	assert.equal(breakdown.at, at);
});
