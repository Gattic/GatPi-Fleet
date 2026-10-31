import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import type { SessionRow } from "../src/manager/model/store.ts";
import { emptyUsage, type Command } from "../src/protocol/index.ts";
import { commandRequest } from "../src/server/contract.ts";
import { Sessions, summary } from "../src/server/sessions.ts";

function fixture() {
	const runtime = new ManagerRuntime({ hosts: ["box"] });
	runtime.store.setState(11, { pid: 11, instanceId: "instance", sessionId: "session", sessionFile: "/sessions/saved.jsonl", cwd: "/project", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	return { runtime, row: runtime.store.rows.get("11")!, sessions: new Sessions(runtime) };
}

test("reload and restart are typed, idle-only actions; restart needs a saved conversation", () => {
	const { row } = fixture();
	for (const kind of ["reload", "restart"] as const) {
		assert.equal(commandRequest.Check({ requestId: randomUUID(), epoch: randomUUID(), revision: summary(row).revision, command: { kind } }), true);
		assert.equal(summary(row).commands[kind], null);
		row.bridge!.phase = "working";
		assert.match(summary(row).commands[kind]!, /idle/);
		row.bridge!.phase = "idle";
		row.bridge!.asks = [{ id: 1, question: "why", answer: "", askedAt: 1, status: "answering" }];
		assert.match(summary(row).commands[kind]!, /side question/);
		row.bridge!.asks = [];
	}
	row.bridge!.sessionFile = undefined;
	assert.match(summary(row).commands.restart!, /saved/);
	assert.equal(summary(row).commands.reload, null);
	row.connected = false;
	assert.match(summary(row).commands.reload!, /disconnected/);
	assert.match(summary(row).commands.restart!, /disconnected/);
});

test("suggestion requests are typed idle-only actions with the same revision guards", async (t) => {
	const { runtime, row, sessions } = fixture();
	const input = { requestId: randomUUID(), epoch: randomUUID(), revision: summary(row).revision, command: { kind: "suggest" as const } };
	assert.equal(commandRequest.Check(input), true);
	assert.equal(summary(row).commands.suggest, null);
	const sent: Command[] = [];
	t.mock.method(runtime.network, "send", async (_row: SessionRow, command: Command) => { sent.push(command); });
	await assert.rejects(sessions.command(summary(row).id, { ...input, revision: "0".repeat(32) }), /state changed/);
	await sessions.command(summary(row).id, input);
	assert.deepEqual(sent, [{ kind: "suggest" }]);
	row.bridge!.phase = "working";
	assert.match(summary(row).commands.suggest!, /idle/);
	await assert.rejects(sessions.command(summary(row).id, { ...input, revision: summary(row).revision }), /idle/);
	row.bridge!.phase = "idle";
	row.connected = false;
	assert.match(summary(row).commands.suggest!, /disconnected/);
	row.exitedAt = Date.now();
	assert.equal(summary(row).commands.suggest, "Session exited");
});

test("remote restart runs on the session host with only its exact identity", async (t) => {
	const { runtime, row } = fixture();
	runtime.store.setState(row.pid, row.bridge!, "box");
	const remote = runtime.network.remote("box");
	const request = t.mock.method(remote, "request", async (op: string, params: unknown, timeout: number) => {
		assert.equal(op, "restart");
		assert.deepEqual(params, { target: { pid: row.pid, sessionId: "session", instanceId: "instance" } });
		assert.equal(timeout, 25_000);
		return "pi-saved-replacement";
	});
	await runtime.restart(runtime.store.rows.get("box:11")!);
	assert.equal(request.mock.callCount(), 1);
});

test("lifecycle actions preserve revision guards and route restart to the host lifecycle, not a prompt", async (t) => {
	const { runtime, row, sessions } = fixture();
	const sent: unknown[] = [];
	t.mock.method(runtime.network, "send", async (_row: SessionRow, command: Command) => { sent.push(command); });
	const restart = t.mock.method(runtime, "restart", async (target: SessionRow) => { assert.equal(target, row); });
	for (const kind of ["reload", "restart"] as const) {
		const current = summary(row);
		const input = { requestId: randomUUID(), epoch: randomUUID(), revision: current.revision, command: { kind } };
		await assert.rejects(sessions.command(current.id, { ...input, revision: "0".repeat(32) }), /state changed/);
		await sessions.command(current.id, input);
	}
	assert.deepEqual(sent, [{ kind: "reload" }]);
	assert.equal(restart.mock.callCount(), 1);
});
