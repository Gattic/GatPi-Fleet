import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piDashBridge from "../src/bridge/index.ts";
import { LineDecoder, MAX_PROMPTS, socketPath, type BridgeMessage, type SessionState } from "../src/protocol/index.ts";
import { RecoveryJournal } from "../src/manager/recovery.ts";

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
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		events: { on: () => {} },
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
	return { handlers, snapshot, root, session, ctx };
}

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
