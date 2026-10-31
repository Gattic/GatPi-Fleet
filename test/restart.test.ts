import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { launchReservation } from "../src/manager/actions/launch.ts";
import { restartSession } from "../src/manager/actions/restart.ts";
import { BridgeHub, UncertainCommandError } from "../src/manager/collectors/bridges.ts";
import { Store } from "../src/manager/model/store.ts";
import { emptyUsage, type SessionIdentity, type Command } from "../src/protocol/index.ts";

function fixture(t: TestContext, pid: number) {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-restart-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "conversation.jsonl");
	writeFileSync(file, "saved conversation");
	const record = join(root, "arguments");
	writeFileSync(join(root, "screen"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Screen version 4.09.01 (GNU)"; exit 0; fi\nprintf "%s\\n" "$@" > "' + record + '"\n', { mode: 0o700 });
	const path = process.env.PATH;
	process.env.PATH = `${root}:${path}`;
	t.after(() => { process.env.PATH = path; });
	const store = new Store(() => {});
	store.setState(pid, { pid, instanceId: "instance", sessionId: "session", sessionFile: file, cwd: root, name: "saved", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	const hub = new BridgeHub(root, { onState() {}, onBye() {}, onDisconnect() {}, onIncompatible() {} });
	return { root, file, record, store, row: store.rows.get(String(pid))!, hub };
}

test("restart waits for graceful process exit and resumes the exact saved file once", async (t) => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
	const closed = once(child, "close");
	t.after(() => child.kill());
	const { root, file, record, store, row, hub } = fixture(t, child.pid!);
	const reservation = launchReservation(file, root);
	mkdirSync(join(root, "launches"));
	writeFileSync(reservation, JSON.stringify({ screen: "old-screen" }));
	const send = t.mock.method(hub, "send", async (target: SessionIdentity, command: Command) => {
		assert.equal(target.instanceId, row.bridge!.instanceId);
		assert.deepEqual(command, { kind: "shutdown" });
		assert.equal(existsSync(record), false, "no replacement before shutdown");
		child.kill("SIGTERM");
		await closed;
		store.bye(row.pid, "quit");
		setTimeout(() => {
			assert.equal(existsSync(record), false, "the old screen's cleanup must release its reservation first");
			rmSync(reservation);
		}, 150);
	});
	assert.match(await restartSession(row, hub, () => store.ordered(), root), /^pi-saved-/);
	assert.equal(send.mock.callCount(), 1);
	assert.equal(readFileSync(file, "utf8"), "saved conversation");
	assert.equal(readFileSync(record, "utf8").split("\n").at(-2), file);
	assert.equal(existsSync(launchReservation(file, root)), true);
});

test("restart never launches after an uncertain shutdown or while the old process lives", async (t) => {
	const { root, record, row, hub } = fixture(t, process.pid);
	t.mock.method(hub, "send", async () => { throw new UncertainCommandError("unknown shutdown outcome"); });
	await assert.rejects(restartSession(row, hub, () => [], root), UncertainCommandError);
	assert.equal(existsSync(record), false);
	t.mock.method(hub, "send", async () => {});
	let now = 0;
	t.mock.method(Date, "now", () => now += 20_000);
	await assert.rejects(restartSession(row, hub, () => [], root), /old process or its launch reservation/);
	assert.equal(existsSync(record), false);
});
