import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RecoveryJournal, processIdentity } from "../src/manager/recovery.ts";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { emptyUsage } from "../src/protocol/index.ts";
import type { RemoteHost } from "../src/manager/remote/host.ts";
import { resumeBlocked } from "../src/manager/actions/launch.ts";
import { Store } from "../src/manager/model/store.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-recovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identities = new Map<number, string | null>([[10, "boot:100"]]);
	const identity = (pid: number) => identities.get(pid);
	const journal = new RecoveryJournal(root, identity);
	const state = { pid: 10, instanceId: "run-a", sessionId: "session-a", sessionFile: join(root, "a.jsonl"), cwd: root, name: "Important work" };
	writeFileSync(state.sessionFile, "saved conversation");
	return { root, identities, identity, journal, state };
}

test("dead sessions survive controller restarts; reused PIDs and reboots do not hide them", (t) => {
	const { root, identities, identity, journal, state } = fixture(t);
	journal.track(state, 100);
	assert.deepEqual(journal.list(), [], "a running process is never a recovery suggestion");
	identities.set(10, null);
	assert.deepEqual(journal.list(), [], "unavailable process information is not proof of a crash");
	identities.delete(10);
	const restarted = new RecoveryJournal(root, identity);
	assert.equal(restarted.list()[0].sessionId, state.sessionId);
	identities.set(10, "boot:999");
	assert.equal(restarted.list().length, 1, "same pid, different start ticks");
	identities.set(10, "other-boot:100");
	assert.equal(restarted.list().length, 1, "same pid/start ticks after a reboot");
	assert.equal(statSync(journal.dir).mode & 0o777, 0o700);
	const file = join(journal.dir, readdirSync(journal.dir)[0]);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).sessionFile, state.sessionFile);
});

test("graceful shutdown removes only that incarnation; ephemeral sessions are not offered", (t) => {
	const { identities, journal, state } = fixture(t);
	journal.track(state);
	journal.close(state.instanceId);
	journal.close(state.instanceId);
	identities.delete(10);
	assert.deepEqual(journal.list(), []);
	journal.track({ ...state, sessionFile: undefined });
	assert.deepEqual(journal.list(), []);
});

test("manual resumption retires dead predecessors only after a new bridge tracks the exact file", (t) => {
	const { identities, journal, state } = fixture(t);
	journal.track(state, 100);
	identities.delete(10);
	assert.equal(journal.list().length, 1);
	identities.set(11, "boot:110");
	journal.track({ ...state, pid: 11, instanceId: "run-b" }, 200);
	assert.deepEqual(journal.list(), []);
	assert.equal(readdirSync(journal.dir).length, 1, "resolved lifecycle metadata does not accumulate");
	assert.throws(() => journal.interrupted("run-a"), /recovery changed/);
	assert.throws(() => journal.dismiss("run-b"), /recovery changed/);
	journal.close("run-a"); // late cleanup from the old incarnation cannot remove the replacement
	identities.delete(11);
	assert.equal(journal.list()[0].instanceId, "run-b", "a second crash is recoverable again");
	journal.dismiss("run-b");
	assert.deepEqual(journal.list(), []);
	assert.equal(readFileSync(state.sessionFile, "utf8"), "saved conversation");
});

test("a live duplicate owner prevents recovery and stale actions; malformed records are not evidence", (t) => {
	const { root, identities, journal, state } = fixture(t);
	journal.track(state, 100);
	identities.set(11, "boot:110");
	journal.track({ ...state, pid: 11, instanceId: "run-b" }, 200);
	identities.delete(11);
	assert.deepEqual(journal.list(), [], "the first owner still runs");
	identities.delete(10);
	assert.equal(journal.list().length, 1, "one suggestion per conversation");
	identities.set(10, "boot:100");
	assert.throws(() => journal.dismiss("run-b"), /recovery changed/);
	identities.delete(10);
	journal.dismiss("run-b");
	writeFileSync(join(journal.dir, "broken.json"), "{broken");
	writeFileSync(join(journal.dir, "invalid.json"), JSON.stringify({ pid: 10 }));
	writeFileSync(join(journal.dir, "unfinished.tmp"), "{unfinished");
	assert.deepEqual(new RecoveryJournal(root).list(), []);
});

test("graceful close of the current run retires a crashed overlapping predecessor", (t) => {
	const { identities, journal, state } = fixture(t);
	journal.track(state, 100);
	identities.set(11, "boot:110");
	journal.track({ ...state, pid: 11, instanceId: "run-b" }, 200);
	identities.delete(10);
	journal.close("run-b");
	identities.delete(11);
	assert.deepEqual(journal.list(), [], "a completed conversation must not reappear as interrupted");
});

test("manual resume is not ordered by wall-clock time", (t) => {
	const { identities, journal, state } = fixture(t);
	journal.track(state, 200);
	identities.delete(10);
	identities.set(11, "boot:110");
	journal.track({ ...state, pid: 11, instanceId: "run-b" }, 100);
	journal.close("run-b");
	identities.delete(11);
	assert.deepEqual(journal.list(), [], "clock correction must not resurrect the old crash");
});

test("dismissing an exited row also dismisses recovery for all controllers", async (t) => {
	const { root, journal, state } = fixture(t);
	journal.track(state);
	const runtime = new ManagerRuntime({ agent: root, runtimeDir: join(root, "runtime"), cacheDir: join(root, "cache") });
	t.after(() => runtime.close());
	runtime.store.setState(state.pid, { ...state, phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	runtime.store.disconnect(state.pid, false);
	await runtime.dismiss(runtime.store.rows.get(String(state.pid))!);
	assert.deepEqual(new RecoveryJournal(root).list(), []);
	assert.equal(existsSync(state.sessionFile), true);
});

test("symlink aliases cannot hide a live owner from recovery or resume guards", (t) => {
	const { root, identities, journal, state } = fixture(t);
	journal.track(state, 100);
	identities.delete(10);
	const alias = join(root, "alias.jsonl"); symlinkSync(state.sessionFile, alias);
	identities.set(11, "boot:110");
	const resumed = { ...state, pid: 11, instanceId: "run-b", sessionFile: alias };
	journal.track(resumed, 200);
	assert.deepEqual(journal.list(), [], "the alias is the same saved conversation");
	const store = new Store(() => {});
	store.setState(resumed.pid, { ...resumed, phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	assert.match(resumeBlocked(store.ordered(), root, state.sessionFile) ?? "", /already open/);
	const remoteRows = store.ordered().map((row) => ({ ...row, host: "box" }));
	assert.equal(resumeBlocked(remoteRows, root, state.sessionFile), undefined, "controller filesystem aliases say nothing about remote paths; the relay must check");
	assert.match(resumeBlocked(remoteRows, root, alias) ?? "", /already open/, "identical remote paths are still blocked immediately");
});

test("a delayed remote dismissal cannot delete a replacement row with the same PID", async (t) => {
	const { root, state } = fixture(t);
	const runtime = new ManagerRuntime({ agent: root, runtimeDir: join(root, "runtime"), cacheDir: join(root, "cache") });
	t.after(() => runtime.close());
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => { finish = resolve; });
	const requests: unknown[] = [];
	t.mock.method(runtime.network, "remote", () => ({ request: async (...args: unknown[]) => { requests.push(args); await pending; return null; } }) as unknown as RemoteHost);
	const bridge = { ...state, phase: "idle" as const, phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] };
	runtime.store.setState(state.pid, bridge, "box");
	runtime.store.disconnect(state.pid, false, "box");
	const dismissed = runtime.dismiss(runtime.store.rows.get(`box:${state.pid}`)!);
	runtime.store.setState(state.pid, { ...bridge, instanceId: "replacement" }, "box");
	finish();
	await dismissed;
	assert.deepEqual(requests, [["dismissRecovery", { instanceId: state.instanceId }]]);
	assert.equal(runtime.store.rows.get(`box:${state.pid}`)?.bridge?.instanceId, "replacement");
});

async function bridge(t: TestContext, root: string): Promise<ChildProcess> {
	const child = fork(fileURLToPath(new URL("./fixtures/recovery-bridge.ts", import.meta.url)), [root], {
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), XDG_RUNTIME_DIR: join(root, "run") },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	await Promise.race([
		once(child, "message"),
		once(child, "exit").then(([code]) => { throw new Error(`bridge fixture exited: ${code}`); }),
	]);
	return child;
}

async function stop(child: ChildProcess, graceful: boolean): Promise<void> {
	const exited = once(child, "exit");
	if (graceful) child.send("quit");
	else child.kill("SIGKILL");
	await exited;
}

test("real bridge SIGKILL without a dashboard leaves a recoverable session; resume and graceful quit clear it", { timeout: 20_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-kill-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const first = await bridge(t, root);
	assert.equal(typeof processIdentity(first.pid!), "string");
	const journal = new RecoveryJournal(join(root, "agent"));
	assert.deepEqual(journal.list(), []);
	await stop(first, false);
	assert.equal(processIdentity(first.pid!), undefined);
	const record = new RecoveryJournal(join(root, "agent")).list()[0];
	assert.equal(record.sessionId, "recover-me");
	assert.equal(record.sessionFile, join(root, "conversation.jsonl"));
	const resumed = await bridge(t, root);
	assert.deepEqual(journal.list(), []);
	await stop(resumed, true);
	assert.deepEqual(journal.list(), []);
	assert.deepEqual(readdirSync(journal.dir), [], "no closed-run metadata left behind");
});

test("SIGKILL during the reload gap retains the current session identity", { timeout: 20_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-reload-kill-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = await bridge(t, root);
	const reloading = once(child, "message");
	child.send("reload");
	await reloading;
	const journal = new RecoveryJournal(join(root, "agent"));
	assert.deepEqual(journal.list(), [], "the process is still alive during reload");
	await stop(child, false);
	assert.equal(journal.list()[0]?.sessionId, "recover-me");
});

test("manager recovery launches the exact persisted file and retains it on failed launches or until bridge startup", async (t) => {
	const { root, identities, journal, state } = fixture(t);
	journal.track(state);
	identities.delete(10);
	// The real process probe also knows fixture pid 10 is not this stored boot/start identity.
	const runtime = new ManagerRuntime({ agent: root, runtimeDir: join(root, "runtime"), cacheDir: join(root, "cache") });
	t.after(() => runtime.close());
	const entry = runtime.recovery.list()[0];
	assert.ok(entry);
	const bin = join(root, "bin"); mkdirSync(bin);
	const capture = join(root, "arguments");
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	t.after(() => { process.env.PATH = path; });
	writeFileSync(join(bin, "screen"), '#!/bin/sh\necho "screen unavailable" >&2\nexit 1\n', { mode: 0o700 });
	await assert.rejects(runtime.resumeInterrupted(entry), /screen unavailable/);
	assert.equal(runtime.recovery.list().length, 1);
	writeFileSync(join(bin, "screen"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\n`, { mode: 0o700 });
	await runtime.resumeInterrupted(entry);
	assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n").slice(-2), ["--session", state.sessionFile]);
	assert.equal(runtime.recovery.list().length, 1, "screen starting is not proof pi resumed");
	await assert.rejects(runtime.resumeInterrupted(entry), /launch is reserved/);
	await runtime.dismissInterrupted(entry);
	assert.deepEqual(runtime.interruptedSessions(), []);
	assert.equal(existsSync(state.sessionFile), true);
	await assert.rejects(runtime.resumeInterrupted(entry), /recovery changed/);
});
