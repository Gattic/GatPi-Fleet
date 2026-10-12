import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseGpuQuery } from "../src/manager/collectors/gpu.ts";
import { Series } from "../src/manager/model/series.ts";
import { deriveStatus, STALL_MS } from "../src/manager/model/status.ts";
import type { ResourceSample } from "../src/manager/collectors/procs.ts";
import { rowLabel, SAMPLE_MS, Store } from "../src/manager/model/store.ts";
import { LANE } from "../src/manager/model/status.ts";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { emptyUsage, type SessionState } from "../src/protocol/index.ts";

const NOW = 1_800_000_000_000;

function bridge(overrides: Partial<SessionState> = {}): SessionState {
	return {
		pid: 1,
		cwd: "/p",
		sessionId: "s",
		instanceId: "instance",
		phase: "idle",
		phaseSince: NOW - 1000,
		lastEventAt: NOW - 1000,
		usage: { direct: emptyUsage(), indirect: emptyUsage() },
		usageMinutes: [],
		tools: [],
		timeline: [],
		models: [],
		asks: [],
		prompts: [],
		...overrides,
	};
}

test("deriveStatus distinguishes the states the board shows", () => {
	const status = (state: Partial<SessionState>, extra: { cpu?: number; connected?: boolean; exitedAt?: number } = {}) =>
		deriveStatus({ bridge: bridge(state), connected: extra.connected ?? true, cpu: extra.cpu ?? 0, exitedAt: extra.exitedAt }, NOW).kind;
	assert.equal(status({}), "ready", "fresh session that never ran");
	assert.equal(status({ lastSettledAt: NOW - 5000 }), "needs-you");
	assert.equal(status({ phase: "working", activity: { kind: "tool", tool: "bash", since: NOW } }), "working");
	assert.equal(status({ phase: "working", lastEventAt: NOW - STALL_MS - 1, activity: { kind: "tool", tool: "bash", since: NOW - STALL_MS - 1 } }), "stalled", "a quiet tool with no CPU may need attention");
	assert.equal(status({ phase: "working", lastEventAt: NOW - STALL_MS - 1, activity: { kind: "tool", tool: "bash", since: NOW - STALL_MS - 1 } }, { cpu: 2 }), "working", "long tool runs that use CPU are not stalls");
	assert.equal(status({ phase: "working", rateLimited: { at: NOW - 1000 } }), "rate-limited");
	assert.equal(status({ lastSettledAt: NOW, lastError: { message: "overloaded", at: NOW } }), "error");
	assert.equal(status({}, { connected: false }), "connecting");
	assert.equal(status({}, { exitedAt: NOW }), "exited");
	assert.equal(deriveStatus({ connected: false, cpu: 0 }, NOW).kind, "unbridged");
	const working = deriveStatus({ bridge: bridge({ phase: "working", activity: { kind: "tool", tool: "build_project", since: NOW - 4000 } }), connected: true, cpu: 1 }, NOW);
	assert.deepEqual(working, { kind: "working", label: "build_project", since: NOW - 4000 });
});

test("remote model work is not stalled merely because events and local CPU are quiet", () => {
	for (const kind of [undefined, "model", "thinking", "writing", "compacting", "continuing"] as const) {
		const since = NOW - STALL_MS * 10;
		const state = bridge({ phase: "working", phaseSince: since, lastEventAt: since, activity: kind ? { kind, since } : undefined });
		assert.equal(deriveStatus({ bridge: state, connected: true, cpu: 0 }, NOW).kind, "working", `${kind ?? "unknown"} can wait on remote work`);
	}
});

test("Series keeps the most recent samples in order", () => {
	const series = new Series(3);
	for (const value of [1, 2, 3, 4]) series.push(value);
	assert.deepEqual(series.last(), [2, 3, 4]);
	assert.deepEqual(series.last(2), [3, 4]);
	assert.equal(series.latest(), 4);
});

test("Store keeps stable slots and gives a recycled session its predecessor's slot", () => {
	const store = new Store(() => {});
	store.setState(10, bridge({ pid: 10, sty: "1.a" }));
	store.setState(20, bridge({ pid: 20, sty: "2.b" }));
	store.setState(30, bridge({ pid: 30, sty: "3.c" }));
	assert.deepEqual(store.ordered().map((row) => row.slot), [1, 2, 3]);
	store.bye(20, "quit");
	store.expectLaunch("pi-b", 2, "20");
	store.setState(40, bridge({ pid: 40, sty: "4.pi-b" }));
	assert.equal(store.rows.has("20"), false, "the exited row is replaced");
	assert.equal(store.rows.get("40")?.slot, 2);
	store.setState(50, bridge({ pid: 50, sty: "5.e" }));
	assert.equal(store.rows.get("50")?.slot, 4);
});

test("Store raises an alert when a session starts needing the user", () => {
	const store = new Store(() => {});
	store.setState(10, bridge({ pid: 10, phase: "working" }));
	assert.equal(store.rows.get("10")?.alertUntil, undefined);
	store.setState(10, bridge({ pid: 10, phase: "idle", lastSettledAt: Date.now() }));
	assert.ok((store.rows.get("10")?.alertUntil ?? 0) > Date.now());
	store.acknowledge("10");
	assert.equal(store.rows.get("10")?.alertUntil, undefined);
});

test("Store does not alert when connecting reveals a state, only when a session enters one", () => {
	const store = new Store(() => {});
	store.setState(10, bridge({ pid: 10, phase: "idle", lastSettledAt: Date.now() }));
	assert.equal(store.rows.get("10")?.status.kind, "needs-you");
	assert.equal(store.rows.get("10")?.alertUntil, undefined, "first contact");
	store.bye(10, "reload");
	assert.equal(store.rows.get("10")?.status.kind, "connecting");
	store.setState(10, bridge({ pid: 10, phase: "idle", lastSettledAt: Date.now() }));
	assert.equal(store.rows.get("10")?.alertUntil, undefined, "reconnect after /reload");
});

test("Store keeps each host's sessions apart: same pids, own samples, and a lost link", () => {
	const store = new Store(() => {});
	const host = { cpu: 0, cores: 1, memUsed: 0, memTotal: 1, load1: 0 };
	const busy: ResourceSample = { directCpu: 0.5, indirectCpu: 0, directMem: 1, indirectMem: 0, directGpuMem: 0, indirectGpuMem: 0, consumers: [], background: [] };
	store.setState(10, bridge({ pid: 10, cwd: "/here" }));
	store.setState(10, bridge({ pid: 10, cwd: "/there" }), "box03");
	assert.deepEqual(store.ordered().map((row) => [row.key, rowLabel(row)]), [["10", "here"], ["box03:10", "there@box03"]]);
	assert.deepEqual(store.targets("box03"), [{ key: "10", pid: 10, sessionId: "s" }]);

	store.applyRemoteSample("box03", { resources: new Map([["10", busy]]), piProcesses: [{ pid: 10, startedAt: 1 }, { pid: 20, startedAt: 1, cwd: "/there/b" }], host }, store.targets("box03"), NOW);
	assert.equal(store.rows.get("box03:20")?.status.kind, "unbridged", "a remote pi without a bridge");
	assert.equal(store.rows.get("box03:10")?.resources?.directCpu, 0.5);
	assert.equal(store.rows.get("10")?.resources, undefined, "another host's sample leaves this machine's rows alone");

	store.hostLost("box03");
	assert.equal(store.rows.has("box03:20"), false, "unbridged rows are only known from samples");
	assert.equal(store.rows.get("box03:10")?.status.kind, "connecting");
	assert.equal(store.rows.get("10")?.status.kind, "ready");
	// Back online: the session ended meanwhile, and the first sample shows it.
	store.applyRemoteSample("box03", { resources: new Map(), piProcesses: [], host }, store.targets("box03"), NOW);
	assert.equal(store.rows.get("box03:10")?.status.kind, "exited");

	// A remote sample answers for the rows it was asked about: a session that appeared and
	// reloaded while it was in flight is not taken for exited.
	const asked = store.targets("box03");
	store.setState(40, bridge({ pid: 40 }), "box03");
	store.disconnect(40, true, "box03");
	store.applyRemoteSample("box03", { resources: new Map(), piProcesses: [], host }, asked, NOW);
	assert.equal(store.rows.get("box03:40")?.status.kind, "connecting");

	store.setState(30, bridge({ pid: 30 }), "box03");
	store.disconnect(30, true, "box03");
	assert.equal(store.rows.get("box03:30")?.status.kind, "connecting", "a live pi reconnects after /reload");
	store.disconnect(30, false, "box03");
	assert.equal(store.rows.get("box03:30")?.status.kind, "exited");
});

test("a launch is claimed only by a session on the host it was launched on", () => {
	const store = new Store(() => {});
	store.setState(10, bridge({ pid: 10, sty: "1.a" }), "box03");
	store.bye(10, "quit", "box03");
	store.expectLaunch("pi-proj-1234abcd", 1, "box03:10", "box03");
	// The same screen name elsewhere (here, or on another host) is someone else's session.
	store.setState(20, bridge({ pid: 20, sty: "2.pi-proj-1234abcd" }));
	store.setState(20, bridge({ pid: 20, sty: "2.pi-proj-1234abcd" }), "box01");
	assert.ok(store.rows.has("box03:10"), "the exited row stays until its replacement arrives");
	assert.notEqual(store.rows.get("20")?.slot, 1);
	store.setState(30, bridge({ pid: 30, sty: "3.pi-proj-1234abcd" }), "box03");
	assert.equal(store.rows.has("box03:10"), false);
	assert.equal(store.rows.get("box03:30")?.slot, 1);
});

test("an exited session dismissed in the dashboard or the gateway leaves both, and nothing else does", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-dismiss-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// Separate processes with their own stores, sharing this user's runtime directory.
	const [dashboard, gateway] = ["dashboard", "gateway"].map((name) => new ManagerRuntime({ agent: join(root, "agent"), runtimeDir: join(root, "run"), cacheDir: join(root, name) }));
	t.after(() => Promise.all([dashboard.close(), gateway.close()]));
	for (const { store } of [dashboard, gateway]) {
		store.setState(10, bridge({ pid: 10, instanceId: "a" }));
		store.setState(20, bridge({ pid: 20, instanceId: "b" }));
		store.setState(10, bridge({ pid: 10, instanceId: "a" }), "box03");
		store.bye(10, "quit");
		store.bye(10, "quit", "box03");
	}
	const keys = (runtime: ManagerRuntime) => [...runtime.store.rows.keys()].sort();

	assert.throws(() => dashboard.dismiss(dashboard.store.rows.get("20")!), /still running/);
	dashboard.dismiss(dashboard.store.rows.get("10")!);
	assert.deepEqual(keys(dashboard), ["20", "box03:10"]);
	gateway.releaseDismissed();
	assert.deepEqual(keys(gateway), ["20", "box03:10"], "the same pid on another host is another session");

	gateway.dismiss(gateway.store.rows.get("box03:10")!);
	dashboard.releaseDismissed();
	assert.deepEqual(keys(dashboard), ["20"]);

	// A later pi with the same pid is a new incarnation: the old dismissal does not hide it.
	dashboard.store.setState(10, bridge({ pid: 10, instanceId: "c" }));
	dashboard.store.bye(10, "quit");
	dashboard.releaseDismissed();
	assert.deepEqual(keys(dashboard), ["10", "20"]);
});

test("Store fills a new row's activity lane from the bridge's timeline", () => {
	const store = new Store(() => {});
	const now = Date.now();
	const minute = 60_000;
	store.setState(10, bridge({ pid: 10, timeline: [{ at: now - 30 * minute, state: "idle" }, { at: now - 20 * minute, state: "working" }, { at: now - 5 * minute, state: "waiting" }] }));
	const lane = store.rows.get("10")?.lane.last() ?? [];
	const count = (state: number) => lane.filter((value) => value === state).length;
	const samples = (minutes: number) => (minutes * minute) / SAMPLE_MS;
	assert.ok(Math.abs(lane.length - samples(30)) <= 1, `30 minutes of samples (${lane.length})`);
	assert.equal(count(LANE.idle), samples(10));
	assert.equal(count(LANE.working), samples(15));
	assert.ok(Math.abs(count(LANE.waiting) - samples(5)) <= 1);

	const before = lane.length;
	store.setState(10, bridge({ pid: 10, timeline: [{ at: now - 50 * minute, state: "working" }] }));
	assert.equal(store.rows.get("10")?.lane.length, before, "later states do not rebuild the lane");
});

test("parseGpuQuery sums devices and per-process VRAM", () => {
	const sample = parseGpuQuery("37, 1024, 4096\n", "1234, 512\n1234, 128\n99, 64\n");
	assert.equal(sample.utilization, 0.37);
	assert.equal(sample.memUsed, 1024 * 1024 * 1024);
	assert.equal(sample.processes.get(1234), 640 * 1024 * 1024);
});
