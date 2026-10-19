// pi-dash-relay and RemoteHost end to end, with the relay as a local child process in place of ssh.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionDirName } from "../src/manager/actions/sessions.ts";
import { UncertainCommandError } from "../src/manager/collectors/bridges.ts";
import { type HostStatus, RemoteHost, type RemoteEvents } from "../src/manager/remote/host.ts";
import { loadHosts, saveHosts, shellQuote, sshCommand } from "../src/manager/remote/hosts.ts";
import { type ClientMessage, emptyUsage, encodeMessage, LineDecoder, PROTOCOL_VERSION, type SessionState, socketPath } from "../src/protocol/index.ts";
import { type GitMethod, RELAY_VERSION } from "../src/relay/protocol.ts";
import { RecoveryJournal } from "../src/manager/recovery.ts";

const RELAY = fileURLToPath(new URL("../src/relay/main.ts", import.meta.url));

async function until<T>(check: () => T | false | undefined, timeout = 8000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const result = check();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("test condition timed out");
}

function recorder() {
	const states: SessionState[] = [];
	const log: string[] = [];
	const events: RemoteEvents = {
		onState: (_pid, state) => states.push(state),
		onBye: (pid, reason) => log.push(`bye ${pid} ${reason}`),
		onDisconnect: (pid, alive) => log.push(`disconnect ${pid} ${alive ? "alive" : "dead"}`),
		onIncompatible: (pid, version) => log.push(`incompatible ${pid} v${version}`),
		onLost: () => log.push("lost"),
	};
	return { states, log, events };
}

test("a remote host's bridges, samples, listings and commands go through the relay", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-relay-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runtime = join(root, "run");
	const agent = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(join(runtime, "pi-dash"), { recursive: true, mode: 0o700 });
	mkdirSync(project);
	const sessionDir = join(agent, "sessions", sessionDirName(project));
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: new Date().toISOString(), cwd: project })}\n`);

	// A bridge of this (live) process on the "remote" host.
	const state: SessionState = { pid: process.pid, cwd: project, sessionFile: join(sessionDir, "a.jsonl"), sessionId: "session", instanceId: "one", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: ["p/m"], asks: [], prompts: [], lastSaid: "hello" };
	const received: ClientMessage[] = [];
	let bridgeSocket: Socket | undefined;
	const bridge: Server = createServer((socket) => {
		bridgeSocket = socket;
		socket.write(encodeMessage({ type: "hello", version: PROTOCOL_VERSION }));
		socket.write(encodeMessage({ type: "snapshot", state }));
		const decoder = new LineDecoder();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const message of decoder.push(chunk) as ClientMessage[]) {
				received.push(message);
				const failed = message.command.kind === "abort";
				socket.write(encodeMessage({ type: "ack", id: message.id, ok: !failed, error: failed ? "nothing to abort" : undefined }));
			}
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => bridge.listen(socketPath(process.pid, join(runtime, "pi-dash")), resolve));
	t.after(() => bridge.close());

	const { states, log, events } = recorder();
	const bin = join(root, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "screen"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Screen version 4.09.01 (GNU)"; fi\nexit 0\n', { mode: 0o700 });
	const remote = new RemoteHost("box", events, ["env", `PATH=${bin}:${process.env.PATH}`, `XDG_RUNTIME_DIR=${runtime}`, `XDG_CONFIG_HOME=${join(root, "config")}`, `PI_CODING_AGENT_DIR=${agent}`, process.execPath, RELAY]);
	t.after(() => remote.close());
	remote.start();
	await until(() => remote.status.kind === "online" && states.length);
	assert.equal(states[0].lastSaid, "hello");
	assert.ok(remote.isConnected(process.pid));

	// Later states travel as patches against the last one.
	bridgeSocket!.write(encodeMessage({ type: "patch", changes: { phase: "working", lastSaid: null } }));
	await until(() => states.length === 2);
	assert.equal(states[1].phase, "working");
	assert.equal(states[1].lastSaid, undefined);
	assert.deepEqual(states[1].models, ["p/m"], "unchanged fields stay");

	await remote.send(states[1], { kind: "prompt", text: "hi", deliverAs: "steer" });
	assert.deepEqual(received.at(-1)?.command, { kind: "prompt", text: "hi", deliverAs: "steer" });
	assert.equal(received.at(-1)?.target.instanceId, "one");
	await assert.rejects(remote.send(states[1], { kind: "abort" }), (error: Error) => error.message === "nothing to abort" && !(error instanceof UncertainCommandError));
	await assert.rejects(remote.send({ ...states[1], instanceId: "old" }, { kind: "abort" }), /session changed/);

	const sample = await remote.sample([{ key: String(process.pid), pid: process.pid, sessionId: "session" }]);
	assert.ok(sample.resources.get(String(process.pid)), "a live target has resources");
	assert.ok(sample.host.memTotal > 0);
	assert.ok(remote.vitals);

	const journal = new RecoveryJournal(agent, () => "old-boot:1");
	journal.track({ ...state, instanceId: "crashed-before-update" });
	await assert.rejects(remote.request("recover", { instanceId: "crashed-before-update" }), /already open/, "host must reject a live bridge even if it predates recovery tracking");
	await assert.rejects(remote.request("launch", { cwd: project, label: "duplicate", sessionFile: state.sessionFile }), /already open/);

	assert.deepEqual((await remote.request("projects", { live: [] })).map((entry) => entry.cwd), [project]);
	assert.deepEqual((await remote.request("sessions", { cwd: project })).map((entry) => entry.sessionId), ["a"]);
	await assert.rejects(remote.request("git", { method: "status", args: [root] }), /not a git repository/, "git runs on the relay's host");
	await assert.rejects(remote.request("git", { method: "constructor" as GitMethod, args: [] }), /unknown git operation/);
	await assert.rejects(remote.request("launch", { cwd: join(root, "missing"), label: "x" }), /ENOENT/);
	await assert.rejects(remote.request("peek", { pid: "../../escape" as unknown as number, sty: "x" }), /invalid pid/, "a peek names only its own capture file");

	bridgeSocket!.destroy();
	await until(() => log.includes(`disconnect ${process.pid} alive`));
	assert.equal(remote.isConnected(process.pid), false);
	const otherFile = join(sessionDir, "other.jsonl");
	writeFileSync(otherFile, "saved transcript");
	journal.track({ ...state, sessionFile: otherFile, instanceId: "other-crash" });
	await assert.rejects(remote.request("recover", { instanceId: "other-crash" }), /no current bridge/, "a disconnected live owner makes project ownership unknown");
});

test("remote recovery discovers persisted records at relay startup and revalidates resume/dismiss requests", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-remote-recovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	const file = join(root, "session.jsonl");
	writeFileSync(file, "saved transcript");
	const journal = new RecoveryJournal(agent, () => "previous-boot:1");
	journal.track({ pid: process.pid, instanceId: "killed", sessionId: "saved", sessionFile: file, cwd: root });
	const bin = join(root, "bin"); mkdirSync(bin);
	const capture = join(root, "arguments");
	writeFileSync(join(bin, "screen"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Screen version 4.09.01 (GNU)"; exit 0; fi\nprintf '%s\\n' "$@" > '${capture}'\n`, { mode: 0o700 });
	const remote = new RemoteHost("box", recorder().events, ["env", `PATH=${bin}:${process.env.PATH}`, `XDG_RUNTIME_DIR=${join(root, "run")}`, `XDG_CONFIG_HOME=${join(root, "config")}`, `PI_CODING_AGENT_DIR=${agent}`, process.execPath, RELAY]);
	t.after(() => remote.close());
	remote.start();
	await until(() => remote.status.kind === "online");
	await remote.sample([]);
	assert.equal(remote.interrupted[0].sessionId, "saved");
	await remote.request("recover", { instanceId: "killed" });
	assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n").slice(-2), ["--session", file]);
	await assert.rejects(remote.request("recover", { instanceId: "killed" }), /launch is reserved/);
	await remote.request("dismissRecovery", { instanceId: "killed" });
	await remote.sample([]);
	assert.deepEqual(remote.interrupted, []);
	assert.equal(readFileSync(file, "utf8"), "saved transcript");
	await assert.rejects(remote.request("recover", { instanceId: "killed" }), /recovery changed/);
});

const HELLO = { type: "hello", version: RELAY_VERSION, bridge: PROTOCOL_VERSION, hostname: "box" };

/** A stand-in relay: prints `lines` (as JSON, or raw text) and stays up for `lifeMs`. */
function fakeRelay(lines: unknown[], lifeMs: number): string[] {
	const output = lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join("");
	return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)}); setTimeout(() => {}, ${lifeMs})`];
}

function offlineError(remote: RemoteHost): string | false {
	return remote.status.kind === "offline" && remote.status.error;
}

test("a host whose relay goes away is reported lost and offline, with the reason", async (t) => {
	const { log, events } = recorder();
	const remote = new RemoteHost("box", events, fakeRelay([HELLO], 300));
	t.after(() => remote.close());
	remote.start();
	await until(() => remote.status.kind === "online");
	const pending = assert.rejects(remote.request("projects", { live: [] }), /lost the connection to box/, "open requests fail with the link");
	const status = await until(() => remote.status.kind === "offline" && remote.status);
	assert.match((status as Extract<HostStatus, { kind: "offline" }>).error, /exited/);
	assert.deepEqual(log, ["lost"]);
	await pending;
});

test("a relay of another version is not used and says how to update it", async (t) => {
	const { log, events } = recorder();
	const remote = new RemoteHost("box", events, fakeRelay([{ ...HELLO, version: RELAY_VERSION + 1 }], 5000));
	t.after(() => remote.close());
	remote.start();
	const status = await until(() => remote.status.kind === "offline" && remote.status);
	assert.match((status as Extract<HostStatus, { kind: "offline" }>).error, /run pi-dash-host add box/);
	assert.deepEqual(log, [], "it was never online");
});

test("a relay that sends something malformed, or speaks before greeting, loses its link instead of crashing pi-dash", async (t) => {
	const state = { pid: 7, cwd: "/p", sessionId: "s", instanceId: "i", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] };
	const cases: [string, unknown[], boolean][] = [
		["a JSON null", [HELLO, "null"], true],
		["a snapshot for another pid", [HELLO, { type: "snapshot", pid: 8, state }], true],
		["a result without an id", [HELLO, { type: "result", ok: true, value: 1 }], true],
		["a snapshot before hello", [{ type: "snapshot", pid: 7, state }, HELLO], false],
	];
	for (const [name, lines, wasOnline] of cases) {
		const { states, log, events } = recorder();
		const remote = new RemoteHost("box", events, fakeRelay(lines, 5000));
		t.after(() => remote.close());
		remote.start();
		assert.match(await until(() => offlineError(remote)), /box sent an invalid message/, name);
		assert.deepEqual(states, [], `${name}: nothing reached the store`);
		assert.deepEqual(log, wasOnline ? ["lost"] : [], name);
	}
});

test("text from a remote host reaches this terminal without control sequences", async (t) => {
	const state = { pid: 7, cwd: "/p", sessionId: "s", instanceId: "i", name: "\x1b]52;c;aGk=\x07\x1b[31mred\x1b[0m\r", lastSaid: "line one\n\tline two\x07", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] };
	const { states, events } = recorder();
	const remote = new RemoteHost("box", events, fakeRelay([{ ...HELLO, hostname: "box\x1b[2J" }, { type: "snapshot", pid: 7, state }], 5000));
	t.after(() => remote.close());
	remote.start();
	await until(() => states.length);
	assert.equal(states[0].name, "red");
	assert.equal(states[0].lastSaid, "line one\n\tline two", "newlines and tabs stay");
	assert.equal(remote.status.kind === "online" && remote.status.hostname, "box");
});

test("a relay that stops answering loses its link", async (t) => {
	const { log, events } = recorder();
	const hung = new RemoteHost("box", events, fakeRelay([HELLO], 5000));
	t.after(() => hung.close());
	hung.start();
	await until(() => hung.status.kind === "online");
	await assert.rejects(hung.request("projects", { live: [] }, 100), /box did not answer \(projects\)/);
	assert.match(offlineError(hung) || "", /box stopped answering \(projects took over 0s\)/);
	assert.deepEqual(log, ["lost"]);
});

test("lost or timed-out git mutation replies are unknown, while git reads are failures", async (t) => {
	for (const timeout of [false, true]) {
		const remote = new RemoteHost("box", recorder().events, fakeRelay([HELLO], timeout ? 5000 : 300));
		t.after(() => remote.close()); remote.start();
		await until(() => remote.status.kind === "online");
		const mutations = ["pull", "push", "pushSetUpstream", "switchBranch"] as const;
		await Promise.all([
			...mutations.map((method) => assert.rejects(remote.request("git", { method, args: ["/project"] }, timeout ? 100 : 5000), UncertainCommandError)),
			assert.rejects(remote.request("git", { method: "status", args: ["/project"] }, 5000), (e: Error) => !(e instanceof UncertainCommandError)),
		]);
	}
});

test("a relay that never greets is dropped and tried again", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const silent = new RemoteHost("box", recorder().events, fakeRelay([], 60_000));
	silent.start();
	t.mock.timers.tick(29_999);
	assert.equal(silent.status.kind, "connecting");
	t.mock.timers.tick(1);
	assert.match(offlineError(silent) || "", /no answer from pi-dash-relay on box within 30s/);
	t.mock.timers.tick(5000);
	assert.equal(silent.status.kind, "connecting", "and it tries again");
	// While setTimeout is still mocked, so its retry timer is the one cleared.
	silent.close();
});

test("hosts.json round-trips and rejects names ssh would take as options", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-hosts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "pi-dash", "hosts.json");
	assert.deepEqual(loadHosts(path), [], "no file, no hosts");
	saveHosts(["box00", "rob@boxhome"], path);
	assert.deepEqual(loadHosts(path), ["box00", "rob@boxhome"]);
	writeFileSync(path, JSON.stringify({ hosts: ["-oProxyCommand=x"] }));
	assert.throws(() => loadHosts(path), /ssh host names/);
	assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
	assert.deepEqual(sshCommand("box00", ["screen", "-rx", "1.a b"]).slice(-4), ["box00", "screen", "-rx", "'1.a b'"]);
});
