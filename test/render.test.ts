import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GpuMonitor } from "../src/dashboard/collectors/gpu.ts";
import { QuotaMonitor } from "../src/dashboard/collectors/quota.ts";
import { Store } from "../src/dashboard/model/store.ts";
import { activityLane, gauge, LANE, planBar, sparkline, splitBar, stackedArea } from "../src/dashboard/ui/charts.ts";
import { renderDetail } from "../src/dashboard/ui/views/detail.ts";
import { renderOverview } from "../src/dashboard/ui/views/overview.ts";
import type { ViewContext } from "../src/dashboard/ui/views/shared.ts";
import { renderUsage } from "../src/dashboard/ui/views/usage.ts";
import { UsageIndex } from "../src/dashboard/usage/usage-index.ts";
import { emptyUsage, type SessionState } from "../src/protocol/index.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("charts render exactly the requested width", () => {
	for (const width of [1, 5, 17, 40]) {
		assert.equal(visibleWidth(sparkline([1, 5, 2, Number.NaN, 8], width)), width);
		assert.equal(visibleWidth(gauge(0.42, width + 2)), width + 2);
		assert.equal(visibleWidth(splitBar(1, 2, 4, width)), width);
		assert.equal(visibleWidth(planBar(3, 7, width)), width);
		assert.equal(visibleWidth(activityLane([LANE.working, LANE.waiting, LANE.idle], width)), width);
		for (const row of stackedArea([1, 2, 3], [1, 1, 1], width, 3, 4)) assert.equal(visibleWidth(row), width);
	}
	assert.equal(strip(planBar(3, 6, 6)), "▰▰▰▱▱▱");
	assert.equal(strip(splitBar(0.01, 0, 100, 5)), "▓░░░░", "small non-zero shares stay visible");
});

function state(pid: number, overrides: Partial<SessionState>): SessionState {
	return {
		pid,
		sty: `${pid}.s${pid}`,
		window: "0",
		cwd: `/home/user/dev/project-${pid}`,
		sessionId: `session-${pid}`,
		phase: "idle",
		phaseSince: Date.now(),
		lastEventAt: Date.now(),
		usage: { direct: { ...emptyUsage(), tokens: 120_000, cost: 4.2 }, indirect: emptyUsage() },
		usageMinutes: [{ minute: Math.floor(Date.now() / 60_000), tokens: 5000, cost: 0.1 }],
		tools: [{ id: "1", name: "bash", detail: "npm test", startedAt: Date.now() - 5000 }],
		...overrides,
	};
}

function context(): ViewContext {
	const store = new Store(() => {});
	store.setState(101, state(101, { phase: "working", activity: { kind: "tool", tool: "bash", detail: "npm test", since: Date.now() - 4000 }, plan: { title: "Ship it", lifecycle: "active", complete: 4, total: 6, blocked: 0, milestones: [{ title: "Build", status: "done" }, { title: "Verify", status: "active" }], activePath: [{ title: "Verify", status: "active", path: "2" }, { title: "Run tests", status: "active", path: "2.1.1" }] } }));
	store.setState(102, state(102, { lastSettledAt: Date.now() - 60_000, lastSaid: "All done — tests pass." }));
	store.setState(103, state(103, { lastSettledAt: Date.now(), lastError: { message: "529 overloaded", at: Date.now() } }));
	store.setState(104, state(104, { name: "a very long session name that needs truncation" }));
	const usage = new UsageIndex({ sessionRoot: "", cachePath: "", retentionMs: 0, onUpdate: () => {} });
	const quota = new QuotaMonitor("/nonexistent");
	quota.windows = [{ provider: "anthropic", providerLabel: "anthropic", label: "5h", usedPercent: 24, resetAt: Date.now() + 3_600_000, windowSeconds: 18000, fetchedAt: Date.now() }];
	return { store, usage, quota, gpu: new GpuMonitor(), now: Date.now(), spinner: "⠹", selected: store.ordered()[0] };
}

test("views fit the terminal at 80, 100 and 140 columns and show each state", () => {
	const ctx = context();
	for (const width of [80, 100, 140]) {
		for (const [name, lines] of [
			["overview", renderOverview(ctx, width, 30)],
			["detail", renderDetail(ctx, width, 40)],
			["usage", renderUsage(ctx, width, 30, "today")],
		] as const) {
			assert.ok(lines.length <= 39, `${name} fits the height`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${name}@${width}: line too wide (${visibleWidth(line)}): ${strip(line)}`);
		}
	}
	const overview = strip(renderOverview(ctx, 120, 30).join("\n"));
	assert.match(overview, /⠹ ⚙ bash/);
	assert.match(overview, /◆ needs you/);
	assert.match(overview, /✖ 529 overloaded/);
	assert.match(overview, /○ ready/);
	assert.match(overview, /▰▰▰▰▱▱ 4\/6 Run tests/);
	assert.match(overview, /PLAN {2}Ship it ▸ Verify ▸ Run tests/);
	assert.match(overview, /anthropic 5h/);
});
