import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { UncertainCommandError } from "../src/manager/collectors/bridges.ts";
import { resumeBlocked } from "../src/manager/actions/launch.ts";
import { sessionDirName } from "../src/manager/actions/sessions.ts";
import { emptyUsage, encodeMessage, LineDecoder, PROTOCOL_VERSION, socketPath, type ClientMessage, type SessionState } from "../src/protocol/index.ts";
import { DeviceStore } from "../src/server/auth.ts";
import { CommandRequestSchema, LaunchRequestSchema, SubscriptionSchema } from "../src/server/contract.ts";
import { Gateway } from "../src/server/gateway.ts";
import { Receipts } from "../src/server/receipts.ts";
import { clean, ref, sessionRef, Sessions, summary } from "../src/server/sessions.ts";

const RELAY = fileURLToPath(new URL("../src/relay/main.ts", import.meta.url));

async function until<T>(check: () => T | false | undefined, timeout = 6000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) { const result = check(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 10)); }
	throw new Error("test condition timed out");
}

test("HTTPS gateway authenticates, streams private projections, and never replays commands", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-server-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cert = join(dir, "cert.pem"); const key = join(dir, "key.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
	const run = join(dir, "run"); const project = join(dir, "project");
	mkdirSync(run); mkdirSync(project);
	const runtime = new ManagerRuntime({ runtimeDir: run, agent: join(dir, "agent"), cacheDir: join(dir, "cache") });
	t.after(() => runtime.close());
	const state: SessionState = { pid: process.pid, instanceId: randomUUID(), sessionId: "session", cwd: project, phase: "idle", phaseSince: 1, lastEventAt: Date.now(), usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], lastSaid: "private reply", lastPrompt: "private prompt" };
	let commands = 0;
	let bridgeSocket: Socket;
	const bridge = createServer((s) => {
		bridgeSocket = s;
		s.write(encodeMessage({ type: "hello", version: PROTOCOL_VERSION }));
		s.write(encodeMessage({ type: "snapshot", state }));
		const decoder = new LineDecoder(); s.setEncoding("utf8");
		s.on("data", (chunk: string) => {
			for (const m of decoder.push(chunk)) {
				const command = m as ClientMessage;
				assert.equal(command.target.instanceId, state.instanceId);
				commands++;
				s.write(encodeMessage({ type: "ack", id: command.id, ok: true }));
			}
		});
	});
	await new Promise<void>((resolve) => bridge.listen(socketPath(process.pid, run), resolve));
	t.after(() => { bridgeSocket?.destroy(); bridge.close(); });
	runtime.hub.scan();
	await until(() => runtime.store.rows.get(String(process.pid))?.connected);
	const devices = new DeviceStore(join(dir, "devices.json"));
	const paired = devices.pair("test phone");
	const gateway = new Gateway({ listen: "127.0.0.1", port: 7443, url: "https://127.0.0.1:7443", label: "test host", cert, key, devices: devices.path, auditDir: join(dir, "audit") }, runtime);
	await gateway.listen(0);
	t.after(() => gateway.close());
	const port = (gateway.server.address() as { port: number }).port;
	const ca = readFileSync(cert);
	const auth = `Bearer ${paired.token}`;
	const get = (path: string, data?: unknown, authorization: string | undefined = auth, origin?: string) => new Promise<{ status: number; data: any }>((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port, path, ca, method: data === undefined ? "GET" : "POST", headers: { ...(authorization ? { Authorization: authorization } : {}), ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" } }, (res) => {
			let text = ""; res.setEncoding("utf8"); res.on("data", (part) => { text += part; }); res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(text) }));
		}); req.on("error", reject); req.end(data === undefined ? undefined : JSON.stringify(data));
	});
	assert.equal((await get("/api/v1/sessions", undefined, "")).status, 401);
	assert.equal((await get("/api/v1/sessions", undefined, auth, "https://evil.invalid")).status, 403);
	await assert.rejects(new Promise((resolve, reject) => { const req = request({ hostname: "127.0.0.1", port, path: "/api/v1/info" }, resolve); req.on("error", reject); req.end(); }), /self-signed/);
	const info = (await get("/api/v1/info")).data;
	assert.equal(info.version, 1);
	// Without an allowlist, project listing, history and launch keep the same device and native-client checks.
	// The launch body names an unlisted project, so even a regression here could not start pi.
	const unlisted = { requestId: randomUUID(), epoch: info.epoch, projectId: ref(tmpdir()) };
	for (const [path, data] of [["/api/v1/projects", undefined], [`/api/v1/projects/${ref(project)}/sessions`, undefined], ["/api/v1/sessions", unlisted]] as const) {
		assert.equal((await get(path, data, "")).status, 401, path);
		assert.equal((await get(path, data, `Bearer ${"A".repeat(43)}`)).status, 401, path);
		assert.equal((await get(path, data, auth, "https://evil.invalid")).status, 403, path);
	}
	assert.deepEqual((await get("/api/v1/projects")).data.projects.map((p: { path: string }) => p.path), [project]);
	const stream = (headers: Record<string, string>) => new Promise((resolve, reject) => {
		const socket = new WebSocket(`wss://127.0.0.1:${port}/api/v1/events`, { ca, headers });
		socket.on("open", () => { socket.terminate(); resolve("open"); }); socket.on("error", reject);
	});
	await assert.rejects(stream({}), /Unexpected server response: 401/);
	await assert.rejects(stream({ Authorization: `Bearer ${"A".repeat(43)}` }), /Unexpected server response: 401/);
	await assert.rejects(stream({ Authorization: auth, Origin: "https://evil.invalid" }), /Unexpected server response: 403/);
	const overview = (await get("/api/v1/sessions")).data.sessions;
	assert.equal(overview.length, 1);
	assert.ok(!JSON.stringify(overview).includes("private"));
	const id = overview[0].id;
	assert.equal((await get(`/api/v1/sessions/${id}`)).data.lastSaid, "private reply");
	const frames: any[] = [];
	const ws = new WebSocket(`wss://127.0.0.1:${port}/api/v1/events`, { ca, headers: { Authorization: auth } });
	ws.on("message", (m) => frames.push(JSON.parse(m.toString())));
	t.after(() => ws.terminate());
	await until(() => frames.find((f) => f.type === "snapshot"));
	ws.send(JSON.stringify({ type: "subscribe", sessionId: id }));
	await until(() => frames.find((f) => f.type === "detail"));
	assert.ok(frames.every((f, i) => f.epoch === info.epoch && f.seq === i + 1));
	const input = { requestId: randomUUID(), epoch: info.epoch, revision: overview[0].revision, command: { kind: "prompt", text: "hello" } };
	const route = `/api/v1/sessions/${id}/commands`;
	await Promise.all([get(route, input), get(route, input)]);
	await until(() => frames.find((f) => f.receipt?.state === "accepted"));
	assert.equal(commands, 1);
	assert.equal((await get(`/api/v1/commands/${input.requestId}`)).data.state, "accepted");
	assert.equal((await get(route, { ...input, command: { kind: "prompt", text: "other" } })).status, 409);
	assert.equal((await get(route, { ...input, requestId: randomUUID(), epoch: randomUUID() })).status, 409);
	assert.equal((await get(route, { ...input, requestId: randomUUID(), command: { kind: "shell", text: "bad" } })).status, 400);
	assert.equal((await get(route, { ...input, requestId: randomUUID(), extra: true })).status, 400);
	const changed = { ...state, instanceId: randomUUID() };
	bridgeSocket!.write(encodeMessage({ type: "snapshot", state: changed }));
	await until(() => gateway.sessions.overview()[0].id !== id);
	await assert.rejects(runtime.hub.send(state, { kind: "abort" }), /session changed/);
	assert.equal((await get(`/api/v1/sessions/${id}`)).status, 404);
	const newId = gateway.sessions.overview()[0].id;
	const fresh = gateway.sessions.detail(newId);
	const stale = { ...input, requestId: randomUUID(), revision: fresh.revision };
	bridgeSocket!.write(encodeMessage({ type: "patch", changes: { phase: "working", phaseSince: 100 } }));
	await until(() => gateway.sessions.detail(newId).revision !== fresh.revision);
	await get(`/api/v1/sessions/${newId}/commands`, stale);
	await until(() => frames.find((f) => f.receipt?.requestId === stale.requestId && f.receipt.state === "failed"));
	assert.equal(commands, 1);
	// Launch takes only a listed project's opaque ID and a session from that project's history.
	assert.equal((await get("/api/v1/sessions", { ...unlisted, cwd: "/" })).status, 400);
	assert.equal((await get("/api/v1/sessions", { ...unlisted, projectId: tmpdir() })).status, 400);
	const rejected = [{ ...unlisted, error: "Project no longer exists; refresh" }, { ...unlisted, requestId: randomUUID(), projectId: ref(project), sessionRef: ref("/etc/passwd"), error: "Historical session no longer exists" }];
	for (const { error, ...launch } of rejected) {
		assert.equal((await get("/api/v1/sessions", launch)).status, 202);
		assert.equal((await until(() => frames.find((f) => f.receipt?.requestId === launch.requestId && f.receipt.state === "failed"))).receipt.error, error);
	}
	// Like the dashboard's new-session picker: any open session's project, with no allowlist.
	const elsewhere = join(dir, "elsewhere"); mkdirSync(elsewhere);
	runtime.store.setState(12345, { ...state, pid: 12345, cwd: elsewhere });
	assert.deepEqual((await gateway.sessions.projects()).projects.map((p) => p.path).sort(), [elsewhere, project].sort());
	runtime.store.bye(12345, "quit");
	assert.deepEqual(await gateway.sessions.projects(), { projects: [{ id: ref(project), host: null, label: "project", path: project }], unreachable: [] });
	// The phone dismisses an exited session; the dashboard, another process with its own store, lets it go too.
	const dashboard = new ManagerRuntime({ runtimeDir: run, agent: join(dir, "agent"), cacheDir: join(dir, "dashboard-cache") });
	t.after(() => dashboard.close());
	dashboard.store.setState(12345, { ...state, pid: 12345, cwd: elsewhere });
	dashboard.store.bye(12345, "quit");
	const listed = (await get("/api/v1/sessions")).data.sessions;
	const exited = listed.find((s: { project: string }) => s.project === elsewhere);
	assert.equal(exited.commands.prompt, "Session exited");
	assert.equal(exited.commands.dismiss, null);
	assert.equal(listed.find((s: { project: string }) => s.project === project).commands.dismiss, "Only exited sessions can be dismissed");
	const dismiss = { requestId: randomUUID(), epoch: info.epoch, revision: exited.revision, command: { kind: "dismiss" } };
	assert.equal((await get(`/api/v1/sessions/${exited.id}/commands`, dismiss)).status, 202);
	await until(() => frames.find((f) => f.receipt?.requestId === dismiss.requestId && f.receipt.state === "accepted"));
	await until(() => frames.findLast((f) => f.type === "snapshot").sessions.length === 1);
	assert.equal(commands, 1, "dismissing does not reach any bridge");
	dashboard.releaseDismissed();
	assert.equal(dashboard.store.rows.has("12345"), false);
	const live = { ...dismiss, requestId: randomUUID(), revision: gateway.sessions.overview()[0].revision };
	await get(`/api/v1/sessions/${newId}/commands`, live);
	assert.equal((await until(() => frames.find((f) => f.receipt?.requestId === live.requestId && f.receipt.state === "failed"))).receipt.error, "Only exited sessions can be dismissed");
	const row = runtime.store.rows.get(String(process.pid))!;
	assert.ok(resumeBlocked([{ ...row, bridge: undefined, proc: { pid: row.pid, cwd: project, startedAt: 1 } }], project, "/file"));
	let closed = false; ws.on("close", () => { closed = true; });
	devices.revoke(paired.device.id);
	assert.equal((await get("/api/v1/info")).status, 401);
	assert.equal((await get("/api/v1/projects")).status, 401);
	await assert.rejects(stream({ Authorization: auth }), /Unexpected server response: 401/);
	await until(() => closed);
	assert.ok(!readFileSync(devices.path, "utf8").includes(paired.token));
});

test("the gateway lists, drives and dismisses the sessions of remote hosts", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-server-hosts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// "box" runs the real relay as a local child process in place of ssh, with its own runtime and agent directories.
	const boxRun = join(dir, "box-run"); const boxAgent = join(dir, "box-agent"); const project = join(dir, "remote-project");
	mkdirSync(join(boxRun, "pi-dash"), { recursive: true, mode: 0o700 }); mkdirSync(project);
	const sessionDir = join(boxAgent, "sessions", sessionDirName(project));
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, "a.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: new Date().toISOString(), cwd: project })}\n`);
	const state: SessionState = { pid: process.pid, instanceId: randomUUID(), sessionId: "a", sessionFile: file, cwd: project, phase: "idle", phaseSince: 1, lastEventAt: Date.now(), usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [] };
	const received: ClientMessage[] = [];
	let bridgeSocket: Socket;
	const bridge = createServer((s) => {
		bridgeSocket = s;
		s.write(encodeMessage({ type: "hello", version: PROTOCOL_VERSION }));
		s.write(encodeMessage({ type: "snapshot", state }));
		const decoder = new LineDecoder(); s.setEncoding("utf8");
		s.on("data", (chunk: string) => {
			for (const command of decoder.push(chunk) as ClientMessage[]) { received.push(command); s.write(encodeMessage({ type: "ack", id: command.id, ok: true })); }
		});
		s.on("error", () => {});
	});
	await new Promise<void>((resolve) => bridge.listen(socketPath(process.pid, join(boxRun, "pi-dash")), resolve));
	t.after(() => { bridgeSocket?.destroy(); bridge.close(); });
	const relay = (host: string) => host === "box" ? ["env", `XDG_RUNTIME_DIR=${boxRun}`, `PI_CODING_AGENT_DIR=${boxAgent}`, process.execPath, RELAY] : [process.execPath, "-e", "process.exit(3)"];
	const runtime = new ManagerRuntime({ runtimeDir: join(dir, "run"), agent: join(dir, "agent"), cacheDir: join(dir, "cache"), hosts: ["box", "gone"], relay });
	t.after(() => runtime.close());
	for (const remote of runtime.network.remotes.values()) remote.start();
	const key = `box:${process.pid}`;
	await until(() => runtime.store.rows.get(key)?.connected);
	const sessions = new Sessions(runtime);
	const [remote] = sessions.overview();
	assert.equal(remote.label, "remote-project@box");
	assert.notEqual(remote.id, ref(`${process.pid}:a:${state.instanceId}`), "the same pid on this machine would be another session");

	// Commands reach the bridge through the host's relay.
	const epoch = randomUUID();
	await sessions.command(remote.id, { requestId: randomUUID(), epoch, revision: remote.revision, command: { kind: "prompt", text: "hi" } });
	assert.deepEqual(received.map((m) => m.command), [{ kind: "prompt", text: "hi" }]);

	// Projects of every host that answers, and which hosts did not.
	const { projects, unreachable } = await sessions.projects();
	assert.deepEqual(projects, [{ id: ref(`box:${project}`), host: "box", label: "remote-project", path: project }]);
	assert.deepEqual(unreachable.map((u) => u.host), ["gone"]);
	// Resuming is checked against the sessions open on that host.
	const [history] = await sessions.history(projects[0].id);
	assert.equal(history.blocked, "That session is already open; select its running session instead");
	await assert.rejects(sessions.launch({ requestId: randomUUID(), epoch, projectId: projects[0].id, sessionRef: history.id }), /already open/);

	bridgeSocket!.write(encodeMessage({ type: "bye", reason: "quit" }));
	await until(() => runtime.store.rows.get(key)?.exitedAt);
	const exited = sessions.overview()[0];
	await sessions.command(exited.id, { requestId: randomUUID(), epoch, revision: exited.revision, command: { kind: "dismiss" } });
	assert.deepEqual(sessions.overview(), []);
	assert.equal(received.length, 1);
});

test("local CLI provisions a private certificate/device and revokes without exposing tokens in list", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-provision-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cli = (...args: string[]) => execFileSync(process.execPath, ["src/server/main.ts", ...args, "--dir", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	cli("init", "--url", "https://127.0.0.1:7443");
	// A leftover allowlist must fail loudly, not be silently ignored as if it still restricted the phone.
	const configPath = join(dir, "config.json");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal("projectRoots" in config, false);
	writeFileSync(configPath, JSON.stringify({ ...config, projectRoots: [dir] }));
	assert.throws(() => cli("list"), /Invalid gateway configuration/);
	writeFileSync(configPath, JSON.stringify(config));
	const pairing = JSON.parse(cli("pair", "--name", "phone"));
	assert.equal(pairing.version, 1);
	assert.equal(pairing.token.length, 43);
	assert.match(pairing.caCertificate, /BEGIN CERTIFICATE/);
	assert.equal(statSync(join(dir, "server.key")).mode & 0o777, 0o600);
	assert.equal(statSync(join(dir, "devices.json")).mode & 0o777, 0o600);
	assert.ok(!cli("list").includes(pairing.token));
	cli("revoke", "--id", pairing.deviceId);
	assert.equal(JSON.parse(cli("list")).length, 0);
	assert.throws(() => cli("init", "--url", "https://127.0.0.1:7443"));
});

test("receipts preserve uncertainty, reject reused content IDs, and do not rerun work", async () => {
	const done: string[] = [];
	const receipts = new Receipts((_device, r) => done.push(r.state));
	let calls = 0;
	const first = receipts.submit("device", "id", { a: 1, b: 2 }, async () => { calls++; throw new UncertainCommandError("lost ack"); });
	assert.equal(receipts.submit("device", "id", { b: 2, a: 1 }, async () => { calls++; }), first);
	await until(() => done.length === 1);
	assert.equal(first.state, "unknown"); assert.equal(calls, 1);
	assert.throws(() => receipts.submit("device", "id", { a: 2 }, async () => {}), /different content/);
	assert.equal(new Receipts(() => {}).get("device", "id"), undefined);
});

test("mobile contract fixtures and projections keep missing metrics missing and strip terminal controls", () => {
	assert.equal(clean("\x1b[31mred\x1b[0m\u0000"), "red");
	const runtime = new ManagerRuntime();
	runtime.store.setState(11, { pid: 11, instanceId: "incarnation", sessionId: "session", cwd: "/project", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [] });
	const row = runtime.store.rows.get("11")!;
	assert.equal(summary(row).resources, null);
	assert.notEqual(sessionRef(row), sessionRef({ ...row, bridge: { ...row.bridge!, instanceId: "new" } }));
	const fixture = JSON.parse(readFileSync(new URL("../api/fixtures/snapshot.json", import.meta.url), "utf8"));
	assert.equal(fixture.version, 1);
	assert.deepEqual(fixture.sessions[0], summary(row));
	const schemas = JSON.parse(readFileSync(new URL("../api/requests.schema.json", import.meta.url), "utf8"));
	assert.deepEqual(schemas, JSON.parse(JSON.stringify({ command: CommandRequestSchema, launch: LaunchRequestSchema, subscribe: SubscriptionSchema })));
});
