// BridgeHub against real unix sockets standing in for bridges of other protocol versions.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeHub } from "../src/manager/collectors/bridges.ts";
import { emptyUsage, encodeMessage, PROTOCOL_VERSION, type SessionState, socketPath } from "../src/protocol/index.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A bridge that greets with `version` and sends a snapshot right after, as real bridges of every version do. */
function fakeBridge(path: string, version: number): Promise<Server> {
	const state: SessionState = { pid: process.pid, cwd: "/p", sessionId: "s", instanceId: "instance", phase: "idle", phaseSince: 0, lastEventAt: 0, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] };
	const server = createServer((socket) => {
		socket.write(encodeMessage({ type: "hello", version }));
		socket.write(encodeMessage({ type: "snapshot", state }));
		socket.on("error", () => {});
	});
	return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

test("a session whose bridge was incompatible is picked up once /reload replaces the bridge", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-hub-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// The socket is named after a live pid, as real bridges are.
	const path = socketPath(process.pid, dir);
	const events: string[] = [];
	const hub = new BridgeHub(dir, {
		onState: () => events.push("state"),
		onBye: () => {},
		onDisconnect: () => {},
		onIncompatible: (_pid, version) => events.push(`incompatible v${version}`),
	});
	t.after(() => hub.close());

	const old = await fakeBridge(path, PROTOCOL_VERSION - 1);
	t.after(() => old.close());
	hub.scan();
	await sleep(200);
	hub.scan();
	await sleep(200);
	assert.deepEqual(events, [`incompatible v${PROTOCOL_VERSION - 1}`], "an incompatible bridge is reported once, not retried");

	// /reload: the old instance removes its socket and the new one listens at the same path.
	await new Promise((resolve) => old.close(resolve));
	try {
		unlinkSync(path);
	} catch {}
	const current = await fakeBridge(path, PROTOCOL_VERSION);
	t.after(() => current.close());
	hub.scan();
	await sleep(200);
	assert.deepEqual(events, [`incompatible v${PROTOCOL_VERSION - 1}`, "state"]);
	assert.ok(hub.isConnected(process.pid));
});
