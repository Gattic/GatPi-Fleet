import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piDashBridge from "../src/bridge/index.ts";
import { LineDecoder, MAX_PROMPTS, socketPath, type BridgeMessage, type SessionState } from "../src/protocol/index.ts";
import { RecoveryJournal } from "../src/manager/recovery.ts";
import { roadmapFixture } from "../scripts/roadmap-fixture.ts";

type Handler = (event: unknown, ctx?: ExtensionContext) => void;

// Drive the extension's registered events and observe its public socket snapshots.
function startBridge(t: TestContext, entries: unknown[] = []) {
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
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command),
		sendUserMessage: (text: string, options: Parameters<ExtensionAPI["sendUserMessage"]>[1]) => sent.push({ text, options }),
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		events: {
			on: (name: string, handler: (data: unknown) => void) => bus.set(name, handler),
			emit: (name: string, data: unknown) => bus.get(name)?.(data),
		},
		getSessionName: () => undefined,
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui", cwd: root, isIdle: () => true, scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => undefined,
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
	return { commands, sent, bus, command, handlers, snapshot, root, session, ctx, publish: (data: unknown) => bus.get("roadmap:changed")!(data) };
}

test("suggest requests the existing publisher, propagates rejection, and never submits a prompt", async (t) => {
	const { command, bus, sent, snapshot, ctx } = startBridge(t);
	const missing = await command({ kind: "suggest" });
	assert.equal(missing.ok, false);
	assert.match(missing.error!, /prompt-suggestions.*update/i);
	let requests = 0;
	bus.set("prompt-suggestion:request", (data) => {
		requests++;
		bus.get("prompt-suggestion:changed")!("Inspect the next task");
		(data as { respond: (error: string | null) => void }).respond(null);
	});
	assert.equal((await command({ kind: "suggest" })).ok, true);
	assert.equal((await snapshot()).suggestion, "Inspect the next task");
	assert.deepEqual(sent, []);
	assert.equal(requests, 1);
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
