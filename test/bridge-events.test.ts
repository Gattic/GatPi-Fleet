import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piDashBridge from "../src/bridge/index.ts";
import { LineDecoder, socketPath, type BridgeMessage, type SessionState } from "../src/protocol/index.ts";

// Drive the extension's registered events and observe its public socket snapshots.
test("bridge counts tool progress and raw provider events as activity", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-events-"));
	const previousRuntime = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	const handlers = new Map<string, (event: unknown, ctx?: ExtensionContext) => void>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx?: ExtensionContext) => void) => handlers.set(name, handler),
		events: { on: () => {} },
		getSessionName: () => undefined,
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui", cwd: root, isIdle: () => true, scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => undefined,
		sessionManager: { getEntries: () => [], getSessionId: () => "test", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	piDashBridge(pi);
	t.after(() => {
		handlers.get("session_shutdown")?.({ reason: "quit" });
		if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = previousRuntime;
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
