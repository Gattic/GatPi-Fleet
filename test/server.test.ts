import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { usageReport } from "../src/server/usage.ts";
import { UncertainCommandError } from "../src/manager/collectors/bridges.ts";
import { resumeBlocked } from "../src/manager/actions/launch.ts";
import { sessionDirName } from "../src/manager/actions/sessions.ts";
import { emptyUsage, encodeMessage, LineDecoder, PROTOCOL_VERSION, socketPath, type ClientMessage, type SessionState } from "../src/protocol/index.ts";
import { DeviceStore } from "../src/server/auth.ts";
import { loadConfig } from "../src/server/config.ts";
import { CommandRequestSchema, GitRequestSchema, LaunchRequestSchema, SubscriptionSchema } from "../src/server/contract.ts";
import { Gateway } from "../src/server/gateway.ts";
import { Receipts } from "../src/server/receipts.ts";
import { SessionGit } from "../src/server/git.ts";
import { clean, ref, sessionRef, Sessions, summary } from "../src/server/sessions.ts";
import { usageFixture } from "../scripts/usage-fixture.ts";
import { contextFixture } from "../scripts/context-fixture.ts";
import { roadmapFixture } from "../scripts/roadmap-fixture.ts";

const RELAY = fileURLToPath(new URL("../src/relay/main.ts", import.meta.url));
const SERVER_MAIN = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
const LATE_ADDRESS = fileURLToPath(new URL("fixtures/late-address.ts", import.meta.url));
const DELAY_LISTEN = new URL("fixtures/delay-listen.ts", import.meta.url).href;

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
	const state: SessionState = { pid: process.pid, instanceId: randomUUID(), sessionId: "session", cwd: project, phase: "idle", phaseSince: 1, lastEventAt: Date.now(), usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: ["private earlier\nprompt", "x".repeat(32_001), "private prompt"], lastSaid: "private reply", lastPrompt: "private prompt" };
	state.plan = roadmapFixture();
	state.context = {
		tokens: 1000, window: 200_000, percent: 0.5,
		breakdown: {
			parts: { system: 100, tools: 200, injected: 0, user: 50, assistant: 100, toolResults: 50, summary: 0 },
			unattributed: 500, totalBasis: "measured", imageTokens: 0,
			counts: { user: 1, assistant: 1, toolResults: 1, injected: 0, imageBlocks: 0 },
			compactAt: 183_616, history: [1000], at: 2,
		},
	};
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
	const gateway = new Gateway({ listen: ["127.0.0.1"], port: 7443, urls: ["https://127.0.0.1:7443"], label: "test host", cert, key, devices: devices.path, auditDir: join(dir, "audit") }, runtime);
	await gateway.listen(0);
	t.after(() => gateway.close());
	const port = gateway.port;
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
	for (const [path, data] of [["/api/v1/projects", undefined], [`/api/v1/projects/${ref(project)}/sessions`, undefined], ["/api/v1/sessions", unlisted], ["/api/v1/usage", undefined], ["/api/v1/context", undefined]] as const) {
		assert.equal((await get(path, data, "")).status, 401, path);
		assert.equal((await get(path, data, `Bearer ${"A".repeat(43)}`)).status, 401, path);
		assert.equal((await get(path, data, auth, "https://evil.invalid")).status, 403, path);
	}
	assert.deepEqual((await get("/api/v1/projects")).data.projects.map((p: { path: string }) => p.path), [project]);
	assert.deepEqual((await get("/api/v1/usage")).data.ranges.map((r: { range: string }) => r.range), ["today", "7d", "30d"]);
	const context = (await get("/api/v1/context")).data;
	assert.deepEqual(context.scopes.map((s: { scope: string }) => s.scope), ["open", "today", "30d"]);
	assert.equal(context.scopes[0].rows[0].breakdown.parts.tools, 200);
	assert.equal(context.scopes[0].rows[0].unbridged, false);
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
	const detail = (await get(`/api/v1/sessions/${id}`)).data;
	assert.equal(detail.lastSaid, "private reply");
	assert.deepEqual(detail.roadmap.entries, state.plan.viewer!.entries);
	assert.deepEqual(detail.context.breakdown.parts, { system: 100, tools: 200, injected: 0, user: 50, assistant: 100, toolResults: 50, summary: 0 });
	assert.equal(detail.context.tokens, 1000);
	assert.equal(overview[0].roadmap, undefined, "nested notes stay out of overview broadcasts");
	assert.deepEqual(detail.prompts, ["private earlier\nprompt", "private prompt"], "only prompts short enough to send again");
	const frames: any[] = [];
	const ws = new WebSocket(`wss://127.0.0.1:${port}/api/v1/events`, { ca, headers: { Authorization: auth } });
	ws.on("message", (m) => frames.push(JSON.parse(m.toString())));
	t.after(() => ws.terminate());
	await until(() => frames.find((f) => f.type === "snapshot"));
	ws.send(JSON.stringify({ type: "subscribe", sessionId: id }));
	await until(() => frames.find((f) => f.type === "detail"));
	assert.ok(frames.every((f, i) => f.epoch === info.epoch && f.seq === i + 1));
	assert.equal(frames.find((f) => f.type === "detail").detail.roadmap.entries[3].status, "blocked");
	bridgeSocket!.write(encodeMessage({ type: "patch", changes: { plan: null } }));
	await until(() => frames.findLast((f) => f.type === "detail")?.detail.roadmap === null);
	assert.equal(commands, 0, "viewing and clearing roadmaps dispatch no session commands");
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
	// A new session screen refuses (a setgid screen run with NoNewPrivileges) tells the phone screen's reason.
	const bin = join(dir, "bin"); mkdirSync(bin);
	writeFileSync(join(bin, "screen"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Screen version 4.09.01 (GNU)'; exit 0; fi\necho \"Directory '/run/screen' must have mode 777.\"\nexit 1\n", { mode: 0o700 });
	const path = process.env.PATH;
	const config = process.env.XDG_CONFIG_HOME;
	// Only the stub, so a regression here cannot start a real screen and pi.
	process.env.PATH = bin;
	process.env.XDG_CONFIG_HOME = join(dir, "config");
	try {
		const refused = { requestId: randomUUID(), epoch: info.epoch, projectId: ref(project) };
		assert.equal((await get("/api/v1/sessions", refused)).status, 202);
		const receipt = (await until(() => frames.find((f) => f.receipt?.requestId === refused.requestId && f.receipt.state !== "received"))).receipt;
		assert.deepEqual([receipt.state, receipt.error], ["failed", "screen could not start pi: Directory '/run/screen' must have mode 777."]);
	} finally {
		process.env.PATH = path;
		if (config === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = config;
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
	const spent = { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, totalTokens: 1150, cost: { total: 0.5 } };
	writeFileSync(file, [
		{ type: "session", version: 3, id: "a", timestamp: new Date().toISOString(), cwd: project },
		{ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [], provider: "anthropic", model: "opus", usage: spent, stopReason: "stop", timestamp: Date.now() } },
	].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	const state: SessionState = { pid: process.pid, instanceId: randomUUID(), sessionId: "a", sessionFile: file, cwd: project, phase: "idle", phaseSince: 1, lastEventAt: Date.now(), usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] };
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
	const relay = (host: string) => host === "box" ? ["env", `XDG_RUNTIME_DIR=${boxRun}`, `XDG_CACHE_HOME=${join(dir, "box-cache")}`, `PI_CODING_AGENT_DIR=${boxAgent}`, process.execPath, RELAY] : [process.execPath, "-e", "process.exit(3)"];
	const runtime = new ManagerRuntime({ runtimeDir: join(dir, "run"), agent: join(dir, "agent"), cacheDir: join(dir, "cache"), hosts: ["box", "gone"], relay });
	t.after(() => runtime.close());
	for (const remote of runtime.network.remotes.values()) remote.start();
	const key = `box:${process.pid}`;
	await until(() => runtime.store.rows.get(key)?.connected);
	const sessions = new Sessions(runtime);
	const [remote] = sessions.overview();
	assert.equal(remote.label, "remote-project@box");

	// The host's relay indexes its own session files, and the gateway counts them as that host's, under its open session.
	await until(() => runtime.usage.hostScanned("box"));
	const [today] = usageReport(runtime).ranges;
	assert.deepEqual(today.cost.hosts, [{ host: null, value: 0 }, { host: "box", value: 0.5 }, { host: "gone", value: 0 }]);
	assert.deepEqual(today.cost.sessions, [{ label: "remote-project@box", open: true, value: 0.5 }]);
	assert.equal(usageReport(runtime).hosts.find((host) => host.host === "box")?.indexing, false);
	assert.notEqual(remote.id, ref(`${process.pid}:a:${state.instanceId}`), "the same pid on this machine would be another session");

	// Git follows the same remote session, not a directory on the gateway's own host.
	execFileSync("git", ["-C", project, "init", "-b", "remote-main"], { stdio: "ignore" });
	const git = new SessionGit(sessions);
	assert.equal((await git.menu(remote.id)).head, "remote-main");
	assert.equal((await git.menu(remote.id)).location, `box:${project}`);
	assert.match((await git.status(remote.id)).text!, /On branch remote-main/);
	assert.deepEqual(await git.branches(remote.id), { branches: [] });

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

test("the gateway listens only on its configured addresses, and waits for one not on any interface yet", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-server-addresses-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cert = join(dir, "cert.pem"); const key = join(dir, "key.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,IP:127.0.0.2,IP:127.0.0.3"], { stdio: "ignore" });
	const runtime = new ManagerRuntime({ runtimeDir: join(dir, "run"), agent: join(dir, "agent"), cacheDir: join(dir, "cache") });
	t.after(() => runtime.close());
	const devices = new DeviceStore(join(dir, "devices.json"));
	const { token } = devices.pair("test phone");
	// Like the LAN and VPN addresses of the same machine, and a VPN that is not connected yet (192.0.2.1 is on no interface).
	const gateway = new Gateway({ listen: ["127.0.0.1", "127.0.0.2", "192.0.2.1"], port: 7443, urls: ["https://127.0.0.1:7443", "https://127.0.0.2:7443"], label: "test host", cert, key, devices: devices.path, auditDir: join(dir, "audit") }, runtime);
	await gateway.listen(0);
	t.after(() => gateway.close());
	const info = (hostname: string) => new Promise<number>((resolve, reject) => {
		const req = request({ hostname, port: gateway.port, path: "/api/v1/info", ca: readFileSync(cert), headers: { Authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode!); });
		req.on("error", reject); req.end();
	});
	assert.equal(await info("127.0.0.1"), 200);
	assert.equal(await info("127.0.0.2"), 200);
	assert.deepEqual(gateway.waitingFor(), ["192.0.2.1"]);
	// Any other address of the machine refuses the connection itself: nothing listens there to accept it.
	await assert.rejects(info("127.0.0.3"), { code: "ECONNREFUSED" });
});

test("a gateway whose port is taken fails to start, and one stopped while it starts listens nowhere", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-server-start-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cert = join(dir, "cert.pem"); const key = join(dir, "key.pem");
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
	const runtime = new ManagerRuntime({ runtimeDir: join(dir, "run"), agent: join(dir, "agent"), cacheDir: join(dir, "cache") });
	t.after(() => runtime.close());
	const gateway = () => new Gateway({ listen: ["127.0.0.1"], port: 7443, urls: ["https://127.0.0.1:7443"], label: "test host", cert, key, devices: join(dir, "devices.json"), auditDir: join(dir, "audit") }, runtime);
	// Another program has the port.
	const other = createServer();
	await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
	t.after(() => other.close());
	const taken = gateway();
	await assert.rejects(taken.listen((other.address() as AddressInfo).port), { code: "EADDRINUSE" });
	await taken.close();
	// Stopped (SIGTERM) during start-up: the address it was listening on as it stopped is closed too.
	const stopped = gateway();
	const starting = stopped.listen(0);
	await stopped.close();
	await starting;
	assert.notEqual(stopped.port, 0, "it was listening when it stopped");
	await assert.rejects(new Promise<void>((resolve, reject) => {
		const socket = connect(stopped.port, "127.0.0.1");
		socket.once("connect", () => { socket.destroy(); resolve(); }).once("error", reject);
	}), { code: "ECONNREFUSED" });
});

const networkNamespaces = spawnSync("unshare", ["-rn", "ip", "link", "set", "lo", "up"]).status === 0;
test("addresses that appear after the gateway starts are served without a restart, unless it was stopped or the port is taken there", { skip: !networkNamespaces && "needs unprivileged network namespaces (unshare -rn) and ip" }, () => {
	const run = spawnSync("unshare", ["-rn", process.execPath, LATE_ADDRESS], { encoding: "utf8", timeout: 30_000 });
	assert.equal(run.status, 0, `fixture failed or did not exit: ${run.stderr}`);
	const output = run.stdout.trim().split("\n");
	const result = JSON.parse(output.at(-1)!);
	assert.deepEqual(result.waitingAtStart, ["10.8.0.2"]);
	assert.equal(result.lan, 200);
	assert.ok(result.listenedAfterMs < 4000, `listened on after ${result.listenedAfterMs} ms`);
	assert.equal(result.vpn, 200);
	assert.equal(result.vpnBack, 200);
	assert.ok(output.includes("pi-dash gateway listening on 10.8.0.2 port 7443"), "the journal says when it starts listening there");
	// Stopped while it started: neither its first address nor the one that appeared later is served.
	assert.equal(result.closedLan, "ECONNREFUSED");
	assert.equal(result.closedAddress, "ECONNREFUSED");
	assert.ok(!output.some((line) => line.includes("10.8.0.3")), "a stopped gateway does not start listening later");
	// Another program has the port at the address that appeared: reported once, then not tried again.
	assert.deepEqual(result.takenWaitingFor, []);
	assert.equal(run.stderr.split("\n").filter((line) => line.includes("pi-dash gateway cannot listen on 10.8.0.4 port 7445: listen EADDRINUSE")).length, 1, run.stderr);
	// Closed while its retry was under way, just after the first of two addresses: it does not go on to the second.
	assert.equal(result.stoppedDuringRetry, true);
	assert.ok(!output.some((line) => line.includes("10.8.0.6")), "a gateway closed during a retry does not listen on further addresses");
	assert.equal(result.stoppedFirst, "ECONNREFUSED");
	assert.equal(result.stoppedSecond, "ECONNREFUSED");
});

test("serve stopped while its gateway starts neither starts the manager nor reports listening", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-stop-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Its own home, agent, runtime and cache directories, and no remote hosts.
	const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "run"), XDG_CACHE_HOME: join(dir, "cache"), PI_CODING_AGENT_DIR: join(dir, "agent") };
	mkdirSync(join(dir, "run"), { mode: 0o700 });
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const port = (probe.address() as AddressInfo).port;
	await new Promise((resolve) => probe.close(resolve));
	execFileSync(process.execPath, ["src/server/main.ts", "init", "--dir", join(dir, "gateway"), "--url", `https://127.0.0.1:${port}`], { env, stdio: "ignore" });
	const serve = spawn(process.execPath, ["--import", DELAY_LISTEN, "src/server/main.ts", "serve", "--dir", join(dir, "gateway")], { env });
	let stdout = "", stderr = "";
	serve.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
	const exited = new Promise<number | null>((resolve) => serve.once("exit", resolve));
	// The fixture holds every listen for 1.5 s: SIGTERM arrives while the gateway is still starting.
	await new Promise<void>((resolve, reject) => {
		serve.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; if (stderr.includes("DELAYING listen")) resolve(); });
		void exited.then(() => reject(new Error(`serve exited before listening: ${stderr}`)));
	});
	serve.kill("SIGTERM");
	assert.equal(await exited, 0, stderr);
	assert.equal(stdout, "", "no listening report");
	assert.equal(existsSync(join(dir, "run", "pi-dash")), false, "the manager runtime was not started");
});

test("a configuration listens on specific addresses and lists each origin once", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "config.json");
	const config = { listen: ["192.168.1.20", "10.8.0.2"], port: 17443, urls: ["https://192.168.1.20:17443", "https://10.8.0.2:17443"], label: "host",
		cert: join(dir, "server.crt"), key: join(dir, "server.key"), devices: join(dir, "devices.json"), auditDir: join(dir, "audit") };
	const load = (change: object) => { writeFileSync(path, JSON.stringify({ ...config, ...change })); return loadConfig(path); };
	assert.deepEqual(load({}), config);
	// Each of these would listen on every interface.
	for (const address of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"]) assert.throws(() => load({ listen: [address] }), /specific IP addresses/, address);
	// The same address twice, however written: it would fail to start with EADDRINUSE.
	for (const pair of [["10.8.0.2", "10.8.0.2"], ["::1", "0:0:0:0:0:0:0:1"], ["fe80::1%lo", "FE80::1%lo"], ["127.0.0.1", "::ffff:127.0.0.1"]]) assert.throws(() => load({ listen: pair }), /different/, pair.join(" "));
	assert.deepEqual(load({ listen: ["::1", "127.0.0.1", "fe80::1%lo", "fe80::1%wlo1"] }).listen, ["::1", "127.0.0.1", "fe80::1%lo", "fe80::1%wlo1"], "different addresses stay as written");
	// The phone refuses a pairing that lists one origin twice, however it is written.
	assert.throws(() => load({ urls: ["https://192.168.1.20", "https://192.168.1.20:443/"] }), /different origin/);
	// The phone reads an IPv4-mapped IPv6 host as its IPv4 address (OkHttp), so these are one origin too.
	assert.throws(() => load({ urls: ["https://127.0.0.1:7443", "https://[::ffff:127.0.0.1]:7443"] }), /different origin/);
	assert.throws(() => load({ urls: ["https://[0:0:0:0:0:FFFF:7F00:1]:7443", "https://127.0.0.1:7443"] }), /different origin/);
	// A configuration from before several addresses fails loudly (docs/ANDROID.md describes the upgrade).
	assert.throws(() => load({ listen: "192.168.1.20", urls: undefined, url: "https://192.168.1.20:17443" }), /Invalid gateway configuration/);
});

test("local CLI provisions a private certificate/device and revokes without exposing tokens in list", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-provision-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const cli = (...args: string[]) => execFileSync(process.execPath, ["src/server/main.ts", ...args, "--dir", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	assert.throws(() => cli("init", "--url", "https://127.0.0.1:7443", "--url", "https://10.8.0.2:7444"), /same port/);
	// init checks the configuration it would write with the same rules, before writing anything.
	assert.throws(() => cli("init", "--url", "https://127.0.0.1:7443", "--listen", "0.0.0.0"), /specific IP addresses/);
	assert.throws(() => cli("init", "--url", "https://127.0.0.1:7443", "--url", "https://127.0.0.1:7443"), /different origin/);
	assert.equal(existsSync(join(dir, "config.json")) || existsSync(join(dir, "server.key")), false);
	cli("init", "--url", "https://127.0.0.1:7443", "--url", "https://10.8.0.2:7443", "--listen", "127.0.0.1", "--listen", "10.8.0.2");
	// A leftover allowlist must fail loudly, not be silently ignored as if it still restricted the phone.
	const configPath = join(dir, "config.json");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	assert.equal("projectRoots" in config, false);
	writeFileSync(configPath, JSON.stringify({ ...config, projectRoots: [dir] }));
	assert.throws(() => cli("list"), /Invalid gateway configuration/);
	writeFileSync(configPath, JSON.stringify(config));
	const pairing = JSON.parse(cli("pair", "--name", "phone"));
	assert.equal(pairing.version, 2);
	// The phone gets every address, in order, and the certificate is valid for each.
	assert.deepEqual(pairing.urls, ["https://127.0.0.1:7443", "https://10.8.0.2:7443"]);
	assert.deepEqual(config.listen, ["127.0.0.1", "10.8.0.2"]);
	assert.equal(new X509Certificate(pairing.caCertificate).subjectAltName, "IP Address:127.0.0.1, IP Address:10.8.0.2");
	assert.equal(pairing.token.length, 43);
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
	runtime.store.setState(11, { pid: 11, instanceId: "incarnation", sessionId: "session", cwd: "/project", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	const row = runtime.store.rows.get("11")!;
	assert.equal(summary(row).resources, null);
	assert.notEqual(sessionRef(row), sessionRef({ ...row, bridge: { ...row.bridge!, instanceId: "new" } }));
	const fixture = JSON.parse(readFileSync(new URL("../api/fixtures/snapshot.json", import.meta.url), "utf8"));
	assert.equal(fixture.version, 1);
	assert.deepEqual(fixture.sessions[0], summary(row));
	const schemas = JSON.parse(readFileSync(new URL("../api/requests.schema.json", import.meta.url), "utf8"));
	assert.deepEqual(schemas, JSON.parse(JSON.stringify({ command: CommandRequestSchema, git: GitRequestSchema, launch: LaunchRequestSchema, subscribe: SubscriptionSchema })));
});

test("mobile projections keep live background work working without attention and drop it for an exited session", () => {
	const runtime = new ManagerRuntime();
	runtime.store.setState(11, { pid: 11, instanceId: "incarnation", sessionId: "session", cwd: "/project", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	const row = runtime.store.rows.get("11")!;
	row.bridge!.lastSettledAt = 5;
	row.resources = {
		directCpu: 0.5, indirectCpu: 0.2, directMem: 1e8, indirectMem: 2e8, directGpuMem: 0, indirectGpuMem: 0,
		consumers: [], childProcesses: 1,
		background: [
			{ kind: "job", label: "nightly-\x1b[31mbuild", detail: "npm run test\x1b[31m\u0000", startedAt: 10, cpu: 0.3, rss: 1e8 },
			{ kind: "subagent", label: "coder", detail: "Review the parser", startedAt: 20, cpu: 0.1, rss: 5e7 },
		],
	};
	runtime.store.tick(30);
	const sessions = new Sessions(runtime);
	for (const session of [sessions.overview()[0], sessions.detail(sessionRef(row))]) {
		assert.equal(session.status.kind, "working", "the phone uses the same background-aware status as the dashboard");
		assert.equal(session.attentionKey, null, "no needs-you notification for background work");
	}
	assert.deepEqual(summary(row).resources?.background, [
		{ kind: "job", label: "nightly-build", detail: "npm run test", startedAt: 10, cpu: 0.3, memory: 1e8 },
		{ kind: "subagent", label: "coder", detail: "Review the parser", startedAt: 20, cpu: 0.1, memory: 5e7 },
	]);
	const background = row.resources.background;
	row.resources.background = [];
	runtime.store.tick(31);
	assert.equal(summary(row).status.kind, "needs-you");
	assert.ok(summary(row).attentionKey);
	row.resources.background = background;
	row.exitedAt = 32;
	runtime.store.tick(32);
	assert.equal(summary(row).status.kind, "exited");
	assert.deepEqual(summary(row).resources?.background, [], "an exited session has no live background work");
});

test("usage is still indexing until this machine and every connected host have scanned; a host that is not connected is not waited for", () => {
	const runtime = new ManagerRuntime({ hosts: ["up", "down"] });
	runtime.network.remote("up").status = { kind: "online", since: 1, hostname: "up" };
	runtime.network.remote("down").status = { kind: "offline", since: 1, error: "unreachable" };
	const report = () => usageReport(runtime, Date.UTC(2026, 0, 15, 12));
	runtime.usage.apply({ type: "update", scanned: true, durationMs: 0, removed: [], changed: [] });
	assert.deepEqual([report().indexing, report().hosts.map((host) => host.indexing)], [true, [true, false]]);
	runtime.usage.applyRemote("up", { reset: true, changed: [], removed: [], scanned: true });
	assert.deepEqual([report().indexing, report().hosts.map((host) => host.indexing)], [false, [false, false]]);
});

test("the usage tab gets the dashboard's usage view as data", (t) => {
	const tz = process.env.TZ;
	process.env.TZ = "UTC";
	t.after(() => {
		if (tz === undefined) delete process.env.TZ;
		else process.env.TZ = tz;
	});
	const report = usageFixture();
	const fixture = JSON.parse(readFileSync(new URL("../api/fixtures/usage.json", import.meta.url), "utf8"));
	assert.deepEqual(fixture, JSON.parse(JSON.stringify(report)), "regenerate with npm run api:generate");
	const [today, week] = report.ranges;
	// An open session is named as in the session list, and its subagents count toward it. Remote hosts' sessions
	// are counted too, named with their host as in the session list.
	assert.deepEqual(today.cost.sessions, [{ label: "pi-dash", open: true, value: 3.25 }, { label: "train@box00", open: true, value: 1.5 }]);
	assert.equal(today.cost.series.at(-1), 4.5);
	// An ended session is named by project and first prompt (or name). Without a price it has tokens, not cost.
	assert.deepEqual(week.tokens.sessions.map((s) => s.label), ["site \u203a Fix the header", "pi-dash", "train@box00 \u203a Evaluate the run", "train@box00", "notes@boxhome \u203a Release notes"]);
	assert.deepEqual(week.cost.sessions.map((s) => s.label), ["pi-dash", "train@box00", "notes@boxhome \u203a Release notes"]);
	assert.deepEqual(week.tokens.models, [{ name: "gpt-6", value: 8e6 }, { name: "claude-opus", value: 3.6e6 }], "one model through two accounts, or two hosts, is one model");
	// 7 and 30 days are whole 6-hour and daily buckets; the last holds the latest 6 or 24 hours, not the current hour alone.
	assert.equal(week.cost.series.length, 28);
	assert.equal(week.cost.series.at(-1), 4.75);
	assert.equal(report.ranges[2].tokens.series.length, 30);
	assert.deepEqual(report.ranges[2].tokens.series.slice(-2), [8e6, 3.1e6]);
	// Each machine's share: this one (null), then the remote hosts in hosts.json order, with or without usage.
	assert.deepEqual(today.cost.hosts, [{ host: null, value: 3.25 }, { host: "box00", value: 1.5 }, { host: "boxhome", value: 0 }]);
	assert.deepEqual(week.tokens.hosts, [{ host: null, value: 8.1e6 }, { host: "box00", value: 3e6 }, { host: "boxhome", value: 5e5 }]);
	assert.deepEqual(report.hosts, [{ host: "box00", status: "online", indexing: false }, { host: "boxhome", status: "offline", indexing: false }]);
	assert.deepEqual(report.quota?.map(({ provider, status }) => ({ provider, status })), [{ provider: "anthropic", status: "fresh" }, { provider: "codex", status: "stale" }]);
	assert.deepEqual(report.quota![0].windows.map((w) => w.usedPercent), [0, 57]);
	assert.deepEqual(report.quota![0].windows[0], { label: "5h", usedPercent: 0, resetAt: null });
	assert.deepEqual(report.quota![1].windows.map((w) => w.label), ["7d"]);
	assert.equal(report.quota![1].message, "Usage endpoint HTTP 429");
	assert.deepEqual(report.cooldowns, [{ provider: "anthropic", until: report.at + 3_600_000 }], "expired cooldowns are omitted, not converted to quota balances");
});

test("the context tab gets measured totals, estimated parts and cumulative scopes as data", () => {
	const report = contextFixture();
	const fixture = JSON.parse(readFileSync(new URL("../api/fixtures/context.json", import.meta.url), "utf8"));
	assert.deepEqual(fixture, JSON.parse(JSON.stringify(report)), "regenerate with npm run api:generate");
	const [open, today, all] = report.scopes;
	assert.deepEqual(report.scopes.map((scope) => scope.scope), ["open", "today", "30d"]);
	assert.deepEqual(open.rows.map((row) => [row.label, row.tokens, row.window, row.percent]), [
		["pi-dash", 166_000, 200_000, 83],
		["legacy", 40_000, 200_000, 20],
		["Site redesign", null, 200_000, null],
	]);
	assert.equal(open.rows[0].breakdown?.unattributed, 18_000);
	assert.equal(open.rows[1].breakdown, null, "an older bridge keeps its measured total without a composition");
	assert.equal(open.rows[2].breakdown?.totalBasis, "estimate");
	assert.equal(open.rows[2].breakdown?.unattributed, null, "an unknown total stays unknown");
	assert.deepEqual(open.cumulative.parts, { system: 14_000, tools: 17_000, injected: 30_000, user: 7_000, assistant: 18_000, toolResults: 70_000, summary: 2_000 });
	assert.equal(open.cumulative.compositionTokens, 166_000);
	assert.equal(open.cumulative.fillTokens, 206_000);
	assert.equal(open.cumulative.fillWindows, 400_000);
	assert.deepEqual([open.cumulative.near, open.cumulative.unknown, open.cumulative.unbridged], [1, 1, 0]);
	assert.equal(open.cumulative.endedTokens, 0);
	assert.equal(today.rows.length, 4);
	assert.deepEqual(today.rows[1].label, "site \u203a Fix the header");
	assert.equal(today.rows[1].window, null, "an ended session's window is unknown until the catalog supplies it");
	assert.equal(today.cumulative.endedTokens, 90_000);
	assert.equal(today.cumulative.endedSessions, 1);
	assert.equal(today.cumulative.unknown, 1);
	assert.equal(today.cumulative.fillTokens, 206_000);
	assert.equal(today.cumulative.fillWindows, 400_000);
	assert.equal(all.rows.length, 5);
	assert.equal(all.cumulative.endedTokens, 90_000);
	assert.equal(all.cumulative.unknown, 2);
	assert.deepEqual(open.cumulative.hosts, [{ host: null, tokens: 206_000 }]);
	assert.deepEqual(today.cumulative.models, [{ model: "claude-opus-5-5", tokens: 90_000, sessions: 1 }], "only the ended fixture row carries a model");
});

test("pi-dash-server list reports a missing configuration directory without failing", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-dash-server-missing-"));
	const missing = join(dir, "not-there");
	const list = spawnSync(process.execPath, [SERVER_MAIN, "list", "--dir", missing], { encoding: "utf8", timeout: 30_000 });
	assert.equal(list.status, 0, list.stderr);
	assert.equal(list.stderr, "");
	assert.match(list.stdout, /^No gateway configuration at .*not-there\/config\.json\. Create one with pi-dash-server init/m);
	assert.equal(existsSync(missing), false, "listing creates nothing");
	// Only list degrades; commands that need the configuration still fail on it.
	const pair = spawnSync(process.execPath, [SERVER_MAIN, "pair", "--dir", missing], { encoding: "utf8", timeout: 30_000 });
	assert.equal(pair.status, 1);
	assert.match(pair.stderr, /ENOENT/);
});
