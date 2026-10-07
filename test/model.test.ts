import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGpuQuery } from "../src/manager/collectors/gpu.ts";
import { parseQuota } from "../src/manager/collectors/quota.ts";
import { Series } from "../src/manager/model/series.ts";
import { deriveStatus, STALL_MS } from "../src/manager/model/status.ts";
import { SAMPLE_MS, Store } from "../src/manager/model/store.ts";
import { LANE } from "../src/manager/model/status.ts";
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
		...overrides,
	};
}

test("deriveStatus distinguishes the states the board shows", () => {
	const status = (state: Partial<SessionState>, extra: { cpu?: number; connected?: boolean; exitedAt?: number } = {}) =>
		deriveStatus({ bridge: bridge(state), connected: extra.connected ?? true, cpu: extra.cpu ?? 0, exitedAt: extra.exitedAt }, NOW).kind;
	assert.equal(status({}), "ready", "fresh session that never ran");
	assert.equal(status({ lastSettledAt: NOW - 5000 }), "needs-you");
	assert.equal(status({ phase: "working", activity: { kind: "tool", tool: "bash", since: NOW } }), "working");
	assert.equal(status({ phase: "working", lastEventAt: NOW - STALL_MS - 1 }), "stalled", "no events and no CPU");
	assert.equal(status({ phase: "working", lastEventAt: NOW - STALL_MS - 1 }, { cpu: 2 }), "working", "long tool runs that use CPU are not stalls");
	assert.equal(status({ phase: "working", rateLimited: { at: NOW - 1000 } }), "rate-limited");
	assert.equal(status({ lastSettledAt: NOW, lastError: { message: "overloaded", at: NOW } }), "error");
	assert.equal(status({}, { connected: false }), "connecting");
	assert.equal(status({}, { exitedAt: NOW }), "exited");
	assert.equal(deriveStatus({ connected: false, cpu: 0 }, NOW).kind, "unbridged");
	const working = deriveStatus({ bridge: bridge({ phase: "working", activity: { kind: "tool", tool: "build_project", since: NOW - 4000 } }), connected: true, cpu: 1 }, NOW);
	assert.deepEqual(working, { kind: "working", label: "build_project", since: NOW - 4000 });
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
	store.expectLaunch("pi-b", 2, 20);
	store.setState(40, bridge({ pid: 40, sty: "4.pi-b" }));
	assert.equal(store.rows.has(20), false, "the exited row is replaced");
	assert.equal(store.rows.get(40)?.slot, 2);
	store.setState(50, bridge({ pid: 50, sty: "5.e" }));
	assert.equal(store.rows.get(50)?.slot, 4);
});

test("Store raises an alert when a session starts needing the user", () => {
	const store = new Store(() => {});
	store.setState(10, bridge({ pid: 10, phase: "working" }));
	assert.equal(store.rows.get(10)?.alertUntil, undefined);
	store.setState(10, bridge({ pid: 10, phase: "idle", lastSettledAt: Date.now() }));
	assert.ok((store.rows.get(10)?.alertUntil ?? 0) > Date.now());
	store.acknowledge(10);
	assert.equal(store.rows.get(10)?.alertUntil, undefined);
});

test("Store does not alert when connecting reveals a state, only when a session enters one", () => {
	const store = new Store(() => {});
	store.setState(10, bridge({ pid: 10, phase: "idle", lastSettledAt: Date.now() }));
	assert.equal(store.rows.get(10)?.status.kind, "needs-you");
	assert.equal(store.rows.get(10)?.alertUntil, undefined, "first contact");
	store.bye(10, "reload");
	assert.equal(store.rows.get(10)?.status.kind, "connecting");
	store.setState(10, bridge({ pid: 10, phase: "idle", lastSettledAt: Date.now() }));
	assert.equal(store.rows.get(10)?.alertUntil, undefined, "reconnect after /reload");
});

test("Store fills a new row's activity lane from the bridge's timeline", () => {
	const store = new Store(() => {});
	const now = Date.now();
	const minute = 60_000;
	store.setState(10, bridge({ pid: 10, timeline: [{ at: now - 30 * minute, state: "idle" }, { at: now - 20 * minute, state: "working" }, { at: now - 5 * minute, state: "waiting" }] }));
	const lane = store.rows.get(10)?.lane.last() ?? [];
	const count = (state: number) => lane.filter((value) => value === state).length;
	const samples = (minutes: number) => (minutes * minute) / SAMPLE_MS;
	assert.ok(Math.abs(lane.length - samples(30)) <= 1, `30 minutes of samples (${lane.length})`);
	assert.equal(count(LANE.idle), samples(10));
	assert.equal(count(LANE.working), samples(15));
	assert.ok(Math.abs(count(LANE.waiting) - samples(5)) <= 1);

	const before = lane.length;
	store.setState(10, bridge({ pid: 10, timeline: [{ at: now - 50 * minute, state: "working" }] }));
	assert.equal(store.rows.get(10)?.lane.length, before, "later states do not rebuild the lane");
});

test("parseQuota reads provider-failover windows", () => {
	const windows = parseQuota({
		usageByProvider: {
			anthropic: { fetchedAt: 5, primary: { usedPercent: 24, resetAt: 100, windowSeconds: 18000 }, secondary: { usedPercent: 26, resetAt: 200, windowSeconds: 604800 } },
			"openai-codex-account-2": { fetchedAt: 6, primary: { usedPercent: 0, resetAt: 300, windowSeconds: 604800 }, credits: {} },
		},
		exhaustedUntilByProvider: { anthropic: 999 },
	});
	assert.deepEqual(
		windows.map((window) => [window.providerLabel, window.label, window.usedPercent, window.exhaustedUntil]),
		[
			["anthropic", "5h", 24, 999],
			["anthropic", "wk", 26, 999],
			["codex#2", "wk", 0, undefined],
		],
	);
});

test("parseGpuQuery sums devices and per-process VRAM", () => {
	const sample = parseGpuQuery("37, 1024, 4096\n", "1234, 512\n1234, 128\n99, 64\n");
	assert.equal(sample.utilization, 0.37);
	assert.equal(sample.memUsed, 1024 * 1024 * 1024);
	assert.equal(sample.processes.get(1234), 640 * 1024 * 1024);
});
