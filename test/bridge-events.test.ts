import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piDashBridge from "../src/bridge/index.ts";
import { emptyUsage, LineDecoder, MAX_PROMPTS, MAX_SUGGESTION_DIRECTION, socketPath, type BridgeMessage, type SessionState } from "../src/protocol/index.ts";
import { RecoveryJournal } from "../src/manager/recovery.ts";
import { roadmapFixture } from "../scripts/roadmap-fixture.ts";

type Handler = (event: unknown, ctx?: ExtensionContext) => void;

// Drive the extension's registered events and observe its public socket snapshots.
interface ModelRef { provider: string; id: string }

function startBridge(t: TestContext, entries: unknown[] = [], catalogue: { scoped?: { model: ModelRef }[]; available?: ModelRef[] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-events-"));
	const previousRuntime = process.env.XDG_RUNTIME_DIR;
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	process.env.PI_CODING_AGENT_DIR = root;
	const session = { id: "test", file: undefined as string | undefined };
	const handlers = new Map<string, Handler>();
	const bus = new Map<string, (data: unknown) => void>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const sent: { text: string; options: Parameters<ExtensionAPI["sendUserMessage"]>[1] }[] = [];
	let idle = true;
	const calls = {
		compacted: [] as (string | undefined)[],
		thinking: [] as string[],
		names: [] as string[],
		models: [] as { provider: string; id: string }[],
		shutdown: 0,
	};
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
		sendUserMessage: (text: string, options: Parameters<ExtensionAPI["sendUserMessage"]>[1]) => sent.push({ text, options }),
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		events: {
			on: (name: string, handler: (data: unknown) => void) => bus.set(name, handler),
			emit: (name: string, data: unknown) => bus.get(name)?.(data),
		},
		getCommands: () => [
			{ name: "review", description: "Review the diff", source: "prompt", sourceInfo: { path: join(root, "prompts/review.md"), source: "prompt", scope: "project", origin: "top-level" } },
			{ name: "skill:commit", description: "Commit work", source: "skill", sourceInfo: { path: join(root, "skills/commit"), source: "skill", scope: "user", origin: "top-level" } },
			{ name: "pi-dash-reload", description: "Reload pi resources from pi-dash", source: "extension", sourceInfo: { path: join(root, "bridge"), source: "extension", scope: "user", origin: "top-level" } },
		],
		getSessionName: () => calls.names.at(-1),
		setSessionName: (name: string) => { calls.names.push(name); },
		setThinkingLevel: (level: string) => { calls.thinking.push(level); },
		setModel: async (model: { provider: string; id: string }) => { calls.models.push(model); return true; },
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui", cwd: root, isIdle: () => idle, scopedModels: catalogue.scoped ?? [],
		modelRegistry: { getAvailable: () => catalogue.available ?? [], find: (provider: string, id: string) => ({ provider, id }) },
		getContextUsage: () => undefined,
		compact: (options?: { customInstructions?: string }) => calls.compacted.push(options?.customInstructions),
		shutdown: () => { calls.shutdown++; },
		sessionManager: { getEntries: () => entries, getSessionId: () => session.id, getSessionFile: () => session.file },
	} as unknown as ExtensionContext;
	piDashBridge(pi);
	t.after(() => {
		handlers.get("session_shutdown")?.({ reason: "quit" });
		if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previousRuntime;
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
		rmSync(root, { recursive: true, force: true });
	});
	handlers.get("session_start")!({}, ctx);

	async function snapshot(): Promise<SessionState> {
		const socket = connect(socketPath(process.pid));
		socket.setEncoding("utf8");
		const decoder = new LineDecoder();
		try {
			for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
				for (const message of decoder.push(String(chunk)) as BridgeMessage[]) {
					if (message.type === "snapshot") return message.state;
				}
			}
			throw new Error("bridge closed before snapshot");
		} finally {
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		}
	}
	async function command(command: object) {
		const target = await snapshot();
		const socket = connect(socketPath(process.pid));
		socket.setEncoding("utf8");
		const decoder = new LineDecoder();
		try {
			socket.write(JSON.stringify({ type: "command", id: 1, target, command }) + "\n");
			for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
				for (const message of decoder.push(String(chunk)) as BridgeMessage[]) if (message.type === "ack") return message;
			}
			throw new Error("bridge closed before acknowledgement");
		} finally {
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		}
	}
	return { commands, sent, bus, command, handlers, snapshot, root, session, ctx, calls, setIdle: (value: boolean) => { idle = value; }, publish: (data: unknown) => bus.get("roadmap:changed")!(data) };
}

test("a scoped session reports the models it could still switch to", async (t) => {
	const opus = { provider: "anthropic", id: "claude-opus" };
	const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
	const state = await startBridge(t, [], { scoped: [{ model: opus }], available: [opus, sol] }).snapshot();
	assert.deepEqual(state.models, ["anthropic/claude-opus"], "the session's scope stays the offered list");
	assert.deepEqual(state.allModels, ["anthropic/claude-opus", "openai-codex/gpt-6.1-sol"], "the rest of the catalogue is still reachable");
});

test("an unscoped session offers every model and reports no separate catalogue", async (t) => {
	const opus = { provider: "anthropic", id: "claude-opus" };
	const sol = { provider: "openai-codex", id: "gpt-6.1-sol" };
	const state = await startBridge(t, [], { available: [opus, sol] }).snapshot();
	assert.deepEqual(state.models, ["anthropic/claude-opus", "openai-codex/gpt-6.1-sol"]);
	assert.equal(state.allModels, undefined, "no scope means no second list");
});

test("suggest requests the existing publisher, propagates rejection, and never submits a prompt", async (t) => {
	const { command, bus, sent, snapshot, ctx } = startBridge(t);
	const missing = await command({ kind: "suggest" });
	assert.equal(missing.ok, false);
	assert.match(missing.error!, /prompt-suggestions.*update/i);
	let requests = 0;
	const directions: unknown[] = [];
	bus.set("prompt-suggestion:request", (data) => {
		requests++;
		directions.push((data as { direction?: unknown }).direction);
		bus.get("prompt-suggestion:changed")!("Inspect the next task");
		(data as { respond: (error: string | null) => void }).respond(null);
	});
	assert.equal((await command({ kind: "suggest" })).ok, true);
	assert.equal((await snapshot()).suggestion, "Inspect the next task");
	assert.deepEqual(sent, []);
	assert.equal(requests, 1);
	assert.deepEqual(directions, [undefined], "a plain request carries no direction");
	assert.equal((await command({ kind: "suggest", direction: "  focus on the failing tests  " })).ok, true);
	assert.deepEqual(directions, [undefined, "focus on the failing tests"], "the publisher receives the trimmed direction");
	assert.equal((await command({ kind: "suggest", direction: "   " })).ok, true);
	assert.equal(directions.at(-1), undefined, "a blank direction is no direction");
	const tooLong = await command({ kind: "suggest", direction: "x".repeat(MAX_SUGGESTION_DIRECTION + 1) });
	assert.equal(tooLong.ok, false);
	assert.match(tooLong.error!, /at most 2000/);
	const notText = await command({ kind: "suggest", direction: 42 });
	assert.equal(notText.ok, false);
	assert.match(notText.error!, /text/);
	assert.equal(requests, 3, "invalid directions never reach the publisher");
	bus.set("prompt-suggestion:request", (data) => (data as { respond: (error: string | null) => void }).respond("Keep the desktop draft"));
	assert.equal((await command({ kind: "suggest" })).error, "Keep the desktop draft");
	t.mock.method(ctx, "isIdle", () => false);
	assert.match((await command({ kind: "suggest" })).error!, /idle/);
	assert.deepEqual(sent, []);
});

test("reload is acknowledged as a typed command and dispatches the command-context reload, never an agent prompt", async (t) => {
	const { commands, sent, snapshot, ctx } = startBridge(t);
	const target = await snapshot();
	const socket = connect(socketPath(process.pid));
	socket.setEncoding("utf8");
	const decoder = new LineDecoder();
	t.after(() => socket.destroy());
	socket.write(JSON.stringify({ type: "command", id: 1, target, command: { kind: "reload" } }) + "\n");
	for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
		const ack = (decoder.push(String(chunk)) as BridgeMessage[]).find((m) => m.type === "ack");
		if (ack?.type === "ack") { assert.equal(ack.ok, true); break; }
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, [{ text: "/pi-dash-reload", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
	let reloaded = false;
	await commands.get("pi-dash-reload")!.handler("", { ...ctx, reload: async () => { reloaded = true; } } as ExtensionCommandContext);
	assert.equal(reloaded, true);
	await assert.rejects(commands.get("pi-dash-reload")!.handler("", { ...ctx, isIdle: () => false } as ExtensionCommandContext), /idle/);
});

test("new session is acknowledged as a typed command and dispatches the command-context newSession, never an agent prompt", async (t) => {
	const { commands, sent, snapshot, ctx, command } = startBridge(t);
	const target = await snapshot();
	const socket = connect(socketPath(process.pid));
	socket.setEncoding("utf8");
	const decoder = new LineDecoder();
	t.after(() => socket.destroy());
	socket.write(JSON.stringify({ type: "command", id: 1, target, command: { kind: "new" } }) + "\n");
	for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
		const ack = (decoder.push(String(chunk)) as BridgeMessage[]).find((m) => m.type === "ack");
		if (ack?.type === "ack") { assert.equal(ack.ok, true); break; }
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(sent, [{ text: "/pi-dash-new", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
	let created = false;
	await commands.get("pi-dash-new")!.handler("", { ...ctx, newSession: async () => { created = true; return { cancelled: false }; } } as ExtensionCommandContext);
	assert.equal(created, true);
	await assert.rejects(commands.get("pi-dash-new")!.handler("", { ...ctx, isIdle: () => false } as ExtensionCommandContext), /idle/);
	t.mock.method(ctx, "isIdle", () => false);
	assert.match((await command({ kind: "new" })).error!, /idle/);
	assert.deepEqual(sent, [{ text: "/pi-dash-new", options: { deliverAs: "followUp", expandPromptTemplates: true } }], "a refused new session never dispatches");
});

test("bridge tracks file/name, retains reload recovery until replacement, and clears intentional session exits", async (t) => {
	const { handlers, snapshot, root, session, ctx } = startBridge(t);
	const journal = new RecoveryJournal(root, () => undefined); // inspect the records as if the owner died
	assert.deepEqual(journal.list(), [], "an ephemeral session is not recoverable");
	for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
		session.file = join(root, `${reason}.jsonl`);
		handlers.get("message_end")!({ message: { role: "user", content: "first prompt" } });
		handlers.get("session_info_changed")!({ name: `work-${reason}` });
		const state = await snapshot();
		assert.equal(state.sessionFile, session.file);
		assert.equal(journal.list()[0].name, `work-${reason}`);
		assert.equal(journal.list()[0].sessionId, session.id);
		handlers.get("session_shutdown")!({ reason });
		if (reason === "reload") {
			assert.equal(journal.list()[0]?.instanceId, state.instanceId, "a crash before replacement startup must remain recoverable");
			assert.deepEqual(new RecoveryJournal(root).list(), [], "reload of a living process is not an interruption");
		} else assert.deepEqual(journal.list(), []);
		if (reason !== "quit") {
			if (reason !== "reload") session.id = `after-${reason}`;
			handlers.get("session_start")!({}, ctx);
			assert.equal(journal.list().length, 1);
			assert.notEqual(journal.list()[0].instanceId, state.instanceId, "replacement retires the reload marker");
		}
	}
});

test("bridge carries nested roadmap viewer snapshots and clears them without invoking the model", async (t) => {
	const { publish, snapshot, handlers, ctx } = startBridge(t);
	const plan = roadmapFixture();
	publish(plan);
	assert.deepEqual((await snapshot()).plan, plan);
	handlers.get("session_shutdown")!({ reason: "reload" });
	publish(plan); // Publishers can run before the replacement bridge's session_start.
	handlers.get("session_start")!({}, ctx);
	assert.deepEqual((await snapshot()).plan?.viewer, plan.viewer);
	publish(null);
	assert.equal((await snapshot()).plan, undefined);
});

test("bridge counts tool progress and raw provider events as activity", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const { handlers, snapshot } = startBridge(t);

	handlers.get("agent_start")!({});
	handlers.get("tool_execution_start")!({ toolCallId: "call", toolName: "bash", args: { command: "long job" } });
	now += 200_000;
	handlers.get("tool_execution_update")!({ toolCallId: "call", partialResult: { content: [{ type: "text", text: "progress" }] } });
	assert.equal((await snapshot()).lastEventAt, now, "tool progress must refresh activity even with no local CPU");

	now += 200_000;
	handlers.get("provider_stream_event")?.({ provider: "test", api: "test", model: "test", data: { type: "reasoning" } });
	assert.equal((await snapshot()).lastEventAt, now, "raw provider progress may arrive without normalized message deltas");
	const lastEventAt = now;
	now += 1000;
	handlers.get("provider_stream_event")?.({ data: {} });
	assert.equal((await snapshot()).lastEventAt, lastEventAt, "stream heartbeats remain coalesced");
});

test("the prompts to recall are the transcript's, each once where it was last sent: the newest that fit, whole", async (t) => {
	const prompt = (text: string) => ({ type: "message", timestamp: new Date(0).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
	const short = Array.from({ length: MAX_PROMPTS }, (_, index) => `p${index}`);
	const [a, b] = ["a".repeat(60_000), "b".repeat(50_000)];
	const { handlers, snapshot } = startBridge(t, [...short, a, "first", "  \n", "second\nline ", b, "first"].map(prompt));
	assert.deepEqual((await snapshot()).prompts, [...short.slice(3), "second\nline", b, "first"], "a prompt that no longer fits is skipped, not cut");
	handlers.get("message_end")!({ message: { role: "user", content: "second\nline" } });
	assert.deepEqual((await snapshot()).prompts, [...short.slice(3), b, "first", "second\nline"], "a prompt sent again moves to the end");
});

test("tool runs carry the call's arguments and bounded output, live and from the transcript", async (t) => {
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const { handlers, snapshot } = startBridge(t);

	handlers.get("agent_start")!({});
	handlers.get("tool_execution_start")!({ toolCallId: "call", toolName: "bash", args: { command: "npm test", cwd: "/project" } });
	const running = (await snapshot()).tools.at(-1)!;
	assert.equal(running.arguments, JSON.stringify({ command: "npm test", cwd: "/project" }));
	assert.equal(running.result, undefined, "a running tool has no result yet");
	assert.equal(running.endedAt, undefined);

	now += 1500;
	handlers.get("tool_execution_end")!({ toolCallId: "call", toolName: "bash", result: { content: [{ type: "text", text: "  all green\n" }] }, isError: false });
	const ended = (await snapshot()).tools.at(-1)!;
	assert.equal(ended.result, "all green", "the tool's text output is kept for detail, trimmed");
	assert.equal(ended.isError, false);
	assert.equal(ended.endedAt, now);
});

test("tool runs restored from a transcript keep arguments and output", async (t) => {
	const at = new Date(0).toISOString();
	const entries = [
		{ type: "message", timestamp: at, message: { role: "assistant", usage: emptyUsage(), content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } }] } },
		{ type: "message", timestamp: at, message: { role: "toolResult", toolCallId: "call", isError: false, content: [{ type: "text", text: "hello" }] } },
	];
	const { snapshot } = startBridge(t, entries);
	const run = (await snapshot()).tools.at(-1)!;
	assert.equal(run.arguments, '{"path":"README.md"}');
	assert.equal(run.result, "hello");
});

test("provider-executed calls are shown and do not hide the model's reply", async (t) => {
	const at = new Date(0).toISOString();
	const assistant = {
		role: "assistant",
		usage: emptyUsage(),
		content: [
			{ type: "toolCall", id: "call-1", name: "acp_execute", arguments: { CommandLine: "npm test" }, providerExecuted: true, providerResult: { content: "all green", isError: false } },
			{ type: "text", text: "Tests pass." },
		],
	};
	const entries = [
		{ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text: "Run the tests" }] } },
		{ type: "message", timestamp: at, message: assistant },
		{ type: "message", timestamp: at, message: { role: "toolResult", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "all green" }] } },
	];
	const { handlers, snapshot } = startBridge(t, entries);
	const state = await snapshot();
	const run = state.tools.at(-1)!;
	assert.equal(run.name, "acp_execute", "an ACP server's call is a tool run like any other");
	assert.equal(run.detail, "npm test");
	assert.equal(run.arguments, '{"CommandLine":"npm test"}');
	assert.equal(run.result, "all green");
	assert.equal(run.isError, false);
	assert.notEqual(run.endedAt, undefined);
	assert.equal(state.lastSaid, "Tests pass.", "the answer travels in the same message as the server's tool calls");

	handlers.get("message_end")!({ message: assistant });
	assert.equal((await snapshot()).lastSaid, "Tests pass.", "the live path keeps the answer too");
});

test("a Pi tool call still suppresses its narration text", async (t) => {
	const at = new Date(0).toISOString();
	const entries = [
		{
			type: "message",
			timestamp: at,
			message: {
				role: "assistant",
				usage: emptyUsage(),
				content: [
					{ type: "text", text: "Running the tests now." },
					{ type: "toolCall", id: "call", name: "bash", arguments: { command: "npm test" } },
				],
			},
		},
	];
	const { snapshot } = startBridge(t, entries);
	const state = await snapshot();
	assert.equal(state.lastSaid, undefined, "text that only narrates Pi's own tool calls is not the reply");
	assert.equal(state.tools.at(-1)?.name, "bash");
});

test("the snapshot publishes the built-ins pi-dash can run, then Pi's resources, without its own commands", async (t) => {
	const { snapshot } = startBridge(t);
	const commands = (await snapshot()).slashCommands;
	assert.deepEqual(commands.slice(0, 3), [
		{ name: "model", description: "Switch the session's model", argumentHint: "<provider/modelId>", source: "builtin" },
		{ name: "thinking", description: "Set the thinking level", argumentHint: "<level>", source: "builtin" },
		{ name: "compact", description: "Summarize the conversation so far", argumentHint: "[instructions]", source: "builtin" },
	]);
	assert.deepEqual(commands.slice(-2), [
		{ name: "review", description: "Review the diff", source: "prompt" },
		{ name: "skill:commit", description: "Commit work", source: "skill" },
	]);
	assert.ok(commands.every((command) => !command.name.startsWith("pi-dash-")), "the bridge's own commands are not offered");
});

test("skills, prompt templates and extension commands run through Pi's own expansion", async (t) => {
	const { command, sent, setIdle } = startBridge(t);
	assert.equal((await command({ kind: "prompt", text: "/skill:commit now" })).ok, true);
	assert.deepEqual(sent.at(-1), { text: "/skill:commit now", options: { expandPromptTemplates: true } });
	assert.equal((await command({ kind: "prompt", text: "/review API compatibility" })).ok, true);
	assert.deepEqual(sent.at(-1), { text: "/review API compatibility", options: { expandPromptTemplates: true } });
	setIdle(false);
	assert.equal((await command({ kind: "prompt", text: "/skill:commit", deliverAs: "followUp" })).ok, true);
	assert.deepEqual(sent.at(-1), { text: "/skill:commit", options: { deliverAs: "followUp", expandPromptTemplates: true } }, "a skill queues as the chosen delivery while the agent works");
	assert.equal(sent.length, 3);
});

test("built-ins with a remote equivalent execute without a prompt", async (t) => {
	const { command, sent, calls } = startBridge(t);
	assert.equal((await command({ kind: "prompt", text: "/thinking high" })).ok, true);
	assert.deepEqual(calls.thinking, ["high"]);
	assert.equal((await command({ kind: "prompt", text: "/model anthropic/claude-sonnet" })).ok, true);
	assert.deepEqual(calls.models, [{ provider: "anthropic", id: "claude-sonnet" }]);
	assert.equal((await command({ kind: "prompt", text: "/name Release" })).ok, true);
	assert.deepEqual(calls.names, ["Release"]);
	assert.equal((await command({ kind: "prompt", text: "/compact keep the decisions" })).ok, true);
	assert.deepEqual(calls.compacted, ["keep the decisions"]);
	assert.equal((await command({ kind: "prompt", text: "/quit" })).ok, true);
	assert.equal(calls.shutdown, 1);
	assert.deepEqual(sent, [], "a built-in is never sent to the model as literal text");
});

test("invalid, desktop-only and internal slash commands fail with a reason", async (t) => {
	const { command, sent, setIdle } = startBridge(t);
	const thinking = await command({ kind: "prompt", text: "/thinking loudly" });
	assert.equal(thinking.ok, false);
	assert.match(thinking.error!, /one of off, minimal/);
	const model = await command({ kind: "prompt", text: "/model claude" });
	assert.equal(model.ok, false);
	assert.match(model.error!, /provider\/modelId/);
	const name = await command({ kind: "prompt", text: "/name" });
	assert.equal(name.ok, false);
	assert.match(name.error!, /session name is/);
	const desktop = await command({ kind: "prompt", text: "/settings" });
	assert.equal(desktop.ok, false);
	assert.match(desktop.error!, /needs desktop pi/);
	const unknown = await command({ kind: "prompt", text: "/frobnicate" });
	assert.equal(unknown.ok, false);
	assert.match(unknown.error!, /unknown slash command \/frobnicate/);
	const internal = await command({ kind: "prompt", text: "/pi-dash-reload" });
	assert.equal(internal.ok, false);
	assert.match(internal.error!, /unknown slash command/);
	setIdle(false);
	const compact = await command({ kind: "prompt", text: "/compact" });
	assert.equal(compact.ok, false);
	assert.match(compact.error!, /idle/);
	assert.deepEqual(sent, [], "nothing invalid reaches the model");
});

test("/new, /clear and /reload dispatch the bridge's idle-only commands after the acknowledgement", async (t) => {
	const { command, sent, setIdle } = startBridge(t);
	const deferred = () => new Promise((resolve) => setImmediate(resolve));
	assert.equal((await command({ kind: "prompt", text: "/new" })).ok, true);
	await deferred();
	assert.deepEqual(sent.at(-1), { text: "/pi-dash-new", options: { deliverAs: "followUp", expandPromptTemplates: true } });
	assert.equal((await command({ kind: "prompt", text: "/clear" })).ok, true);
	await deferred();
	assert.equal(sent.at(-1)!.text, "/pi-dash-new");
	assert.equal((await command({ kind: "prompt", text: "/reload" })).ok, true);
	await deferred();
	assert.deepEqual(sent.at(-1), { text: "/pi-dash-reload", options: { deliverAs: "followUp", expandPromptTemplates: true } });
	setIdle(false);
	assert.equal((await command({ kind: "prompt", text: "/reload" })).ok, false);
	assert.equal((await command({ kind: "prompt", text: "/new" })).ok, false);
	assert.equal(sent.length, 3);
});
