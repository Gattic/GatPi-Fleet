// The side-question request: the session's full model context (compaction-aware, with tool calls
// and results), live state for what has not reached the transcript, and the question last.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { ASK_PREAMBLE, answerOf, buildAskContext, cacheBeforeQuestion, LIVE_TAIL, type LiveState } from "../src/bridge/ask.ts";

const NOW = 1_800_000_000_000;
const SYSTEM = "You are the session's agent. Project rules: AGENTS.md says use tabs.";
const TOOLS: Tool[] = [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } as never }];
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason, timestamp: NOW };
}

function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: NOW };
}

function result(toolCallId: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: NOW };
}

function call(id: string, command: string) {
	return { type: "toolCall" as const, id, name: "bash", arguments: { command } };
}

function text(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map((block) => ("text" in block ? block.text : "")).join("\n");
}

/** A session that was compacted once, then ran a parallel tool batch: `npm test` finished, `sleep 120` did not. */
function compactedSession() {
	const session = SessionManager.inMemory("/project");
	session.appendMessage(user("Fix the flaky parser test"));
	session.appendMessage(assistant([call("old", "cat parser.ts")]));
	session.appendMessage(result("old", "SUMMARIZED-AWAY: only the summary remembers this"));
	session.appendMessage(assistant([{ type: "text", text: "Found the race." }], "stop"));
	const kept = session.appendMessage(user("Now run the tests"));
	session.appendCompaction("The user's dashboard runs as pid 565174. The parser race was fixed.", kept, 90_000);
	session.appendCustomMessageEntry("repo-context", "branch main; 2 files changed", false);
	session.appendMessage(
		assistant([
			{ type: "thinking", thinking: "Run both in parallel.", thinkingSignature: "sig" },
			{ type: "text", text: "Running the suite." },
			call("call-test", "npm test"),
			call("call-sleep", "sleep 120"),
		]),
	);
	session.appendMessage(result("call-test", "FAILED: 3 of 120 tests\nparser.test.ts: expected 4, got 5"));
	return buildSessionContext(session.getEntries(), session.getLeafId()).messages;
}

const idle: LiveState = { phase: "idle", phaseSince: NOW - 300_000, running: [] };

test("the ask carries the session's whole model context unchanged, with its system prompt and tools", () => {
	const messages = compactedSession();
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages, live: idle, question: "What failed?", now: NOW });
	assert.equal(context.systemPrompt, SYSTEM);
	assert.deepEqual(context.tools, TOOLS);
	assert.deepEqual(context.messages.slice(0, -1), convertToLlm(messages), "everything the model sees, in order, before the question");
	const assistantTurn = context.messages.find((message) => message.role === "assistant") as AssistantMessage;
	assert.deepEqual(
		assistantTurn.content.map((block) => block.type),
		["thinking", "text", "toolCall", "toolCall"],
		"tool calls and thinking are kept, not flattened to text",
	);
	const question = context.messages.at(-1) as UserMessage;
	assert.equal(question.role, "user");
	assert.match(text(question), new RegExp(`^${ASK_PREAMBLE.replace(/[[\].]/g, "\\$&")}`));
	assert.match(text(question), /Session status: idle for 5m00s, waiting for the user\./);
	assert.match(text(question), /Question: What failed\?$/);
});

test("a transcript that declares its prompt and tools (pi 1.x) is sent as is, without a second prompt", () => {
	const session = SessionManager.inMemory("/project");
	session.appendMessage({ role: "system", content: "", sections: { preamble: "You are pi." }, toolsAdded: TOOLS, timestamp: NOW });
	session.appendMessage(user("hello"));
	const messages = buildSessionContext(session.getEntries(), session.getLeafId()).messages;
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages, live: idle, question: "q", now: NOW });
	assert.equal(context.systemPrompt, undefined);
	assert.equal(context.tools, undefined);
	assert.deepEqual(
		context.messages.map((message) => message.role),
		["system", "user", "user"],
	);
	assert.deepEqual(context.messages[0], convertToLlm(messages)[0]);
});

test("after a compaction the ask sees the summary and the kept messages, not the summarized ones", () => {
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages: compactedSession(), live: idle, question: "q", now: NOW });
	const all = context.messages.map(text).join("\n");
	assert.match(text(context.messages[0]), /compacted into the following summary[\s\S]*pid 565174/);
	assert.match(text(context.messages[1]), /Now run the tests/);
	assert.match(text(context.messages[2]), /branch main; 2 files changed/, "extension-injected context is kept");
	assert.doesNotMatch(all, /SUMMARIZED-AWAY/);
});

test("tool outputs reach the ask verbatim", () => {
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages: compactedSession(), live: idle, question: "q", now: NOW });
	const testResult = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "call-test");
	assert.equal(text(testResult as Message), "FAILED: 3 of 120 tests\nparser.test.ts: expected 4, got 5");
});

test("a long session is sent whole, not cut to its recent messages", () => {
	const session = SessionManager.inMemory("/project");
	session.appendMessage(user("start"));
	for (let index = 0; index < 150; index++) {
		session.appendMessage(assistant([call(`c${index}`, `echo ${index}`)]));
		session.appendMessage(result(`c${index}`, `output ${index}`));
	}
	const messages = buildSessionContext(session.getEntries(), session.getLeafId()).messages;
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages, live: idle, question: "q", now: NOW });
	assert.equal(context.messages.length, 302);
	assert.equal(text(context.messages[2]), "output 0");
});

test("a running tool's unanswered call gets a still-running result after the results already in", () => {
	const output = `${"x".repeat(5000)}LATEST-LINE`;
	const live: LiveState = { phase: "working", phaseSince: NOW - 130_000, running: [{ id: "call-sleep", name: "bash", startedAt: NOW - 125_000, output }] };
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages: compactedSession(), live, question: "What are you doing?", now: NOW });
	const roles = context.messages.map((message) => (message.role === "toolResult" ? `toolResult:${message.toolCallId}` : message.role));
	assert.deepEqual(roles.slice(-4), ["assistant", "toolResult:call-test", "toolResult:call-sleep", "user"]);
	const running = context.messages.at(-2) as ToolResultMessage;
	assert.equal(running.isError, false, "not reported as a failure");
	assert.equal(running.toolName, "bash");
	assert.match(text(running), /^Still running \(started 2m05s ago\)\. Output so far:\n…x+LATEST-LINE$/);
	assert.ok(text(running).length < LIVE_TAIL + 100, "only the tail of the output");
	const question = text(context.messages.at(-1) as Message);
	assert.match(question, /Session status: working for 2m10s\./);
	assert.match(question, /Tools still running: bash \(started 2m05s ago\)/);
});

test("an orphaned call that is not running is left to pi-ai, as in the session's own requests", () => {
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages: compactedSession(), live: idle, question: "q", now: NOW });
	assert.ok(!context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "call-sleep"));
	assert.ok(!context.messages.map(text).join("\n").includes("Still running"));
});

test("the reply being streamed is described in the question: thinking tail, text and prepared tool calls", () => {
	const session = SessionManager.inMemory("/project");
	session.appendMessage(user("Fix it"));
	const messages = buildSessionContext(session.getEntries(), session.getLeafId()).messages;
	const thinking = `${"t".repeat(3000)}CURRENT-IDEA`;
	const partial = assistant([
		{ type: "thinking", thinking },
		{ type: "text", text: "The failures are in" },
		{ type: "toolCall", id: "p1", name: "edit", arguments: { path: "src/parser.ts" } },
	]);
	const live: LiveState = { phase: "working", phaseSince: NOW - 20_000, partial, running: [] };
	const context = buildAskContext({ systemPrompt: SYSTEM, tools: TOOLS, messages, live, question: "q", now: NOW });
	assert.deepEqual(
		context.messages.map((message) => message.role),
		["user", "user"],
		"the partial reply is not replayed as a turn; the question follows the unanswered prompt",
	);
	const question = text(context.messages[1]);
	assert.match(question, /Your reply in progress \(not in the transcript yet\):/);
	assert.match(question, /Thinking so far:\n…t+CURRENT-IDEA/);
	assert.ok(!question.includes("t".repeat(LIVE_TAIL)), "only the tail of the thinking");
	assert.match(question, /Text so far:\nThe failures are in/);
	assert.match(question, /Preparing tool call: edit \{"path":"src\/parser.ts"\}/);
});

test("answerOf takes the text, and fails when the model only calls a tool or errors", () => {
	assert.deepEqual(answerOf(assistant([{ type: "text", text: " It is running npm test. " }], "stop")), { answer: "It is running npm test." });
	assert.deepEqual(answerOf(assistant([{ type: "text", text: "Let me check." }, call("x", "ls")])), { answer: "Let me check." });
	assert.deepEqual(answerOf(assistant([call("x", "ls")])), { error: "tried to call bash instead of answering" });
	assert.deepEqual(answerOf({ ...assistant([], "error"), errorMessage: "prompt is too long" }), { error: "prompt is too long" });
	assert.deepEqual(answerOf(assistant([], "aborted")), { error: "aborted" });
});

test("the Anthropic cache mark moves from the question to the end of the session's context", () => {
	const mark = { type: "ephemeral" };
	const payload = {
		system: [{ type: "text", text: "prompt", cache_control: mark }],
		messages: [
			{ role: "user", content: "Fix it" },
			{ role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Fixed." }] },
			{ role: "user", content: [{ type: "text", text: "[Side question…] Why?", cache_control: mark }] },
		],
	};
	cacheBeforeQuestion(payload);
	assert.deepEqual(payload.messages[1].content, [{ type: "thinking", thinking: "…" }, { type: "text", text: "Fixed.", cache_control: mark }]);
	assert.deepEqual(payload.messages[2].content, [{ type: "text", text: "[Side question…] Why?" }], "the question is not cached; the mark count is unchanged");
	assert.deepEqual(payload.system[0].cache_control, mark);

	const unanswered = { messages: [{ role: "user", content: "Fix it" }, { role: "user", content: [{ type: "text", text: "q", cache_control: mark }] }] };
	cacheBeforeQuestion(unanswered);
	assert.deepEqual(unanswered.messages[0].content, [{ type: "text", text: "Fix it", cache_control: mark }], "string content becomes a marked block");

	const thinkingLast = { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] }, { role: "user", content: [{ type: "text", text: "q", cache_control: mark }] }] };
	cacheBeforeQuestion(thinkingLast);
	assert.deepEqual(thinkingLast.messages[1].content[0], { type: "text", text: "q", cache_control: mark }, "thinking blocks cannot be marked, so the mark stays");

	const openai = { input: [{ role: "user", content: "q" }], messages: [{ role: "user", content: "a" }, { role: "user", content: "q" }] };
	const before = structuredClone(openai);
	cacheBeforeQuestion(openai);
	assert.deepEqual(openai, before, "payloads without Anthropic marks are left alone");
});
