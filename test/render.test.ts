import assert from "node:assert/strict";
import { test } from "node:test";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { GpuMonitor } from "../src/dashboard/collectors/gpu.ts";
import { QuotaMonitor } from "../src/dashboard/collectors/quota.ts";
import { Store } from "../src/dashboard/model/store.ts";
import { activityLane, gauge, LANE, planBar, sparkline, splitBar, stackedArea, stretch } from "../src/dashboard/ui/charts.ts";
import { AskView } from "../src/dashboard/ui/overlays.ts";
import { TextPane } from "../src/dashboard/ui/text-pane.ts";
import { theme } from "../src/dashboard/ui/theme.ts";
import { renderDetail } from "../src/dashboard/ui/views/detail.ts";
import { renderOverview } from "../src/dashboard/ui/views/overview.ts";
import type { ViewContext } from "../src/dashboard/ui/views/shared.ts";
import { renderUsage } from "../src/dashboard/ui/views/usage.ts";
import { UsageIndex } from "../src/dashboard/usage/usage-index.ts";
import { type AskRun, emptyUsage, type SessionState } from "../src/protocol/index.ts";

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
	assert.equal(strip(gauge(0.25, 6)), "━╸━━━━", "gauges fill in half cells");
	assert.deepEqual(stretch([1, 2], 5), [1, 1, 1, 2, 2], "a series covering the whole range spans the chart");
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
		timeline: [],
		models: [],
		asks: [],
		...overrides,
	};
}

function context(): ViewContext {
	const store = new Store(() => {});
	store.setState(101, state(101, { phase: "working", context: { tokens: 166_000, window: 200_000, percent: 83 }, activity: { kind: "tool", tool: "bash", detail: "npm test", since: Date.now() - 4000 }, plan: { title: "Ship it", lifecycle: "active", complete: 4, total: 6, blocked: 0, milestones: [{ title: "Build", status: "done" }, { title: "Verify", status: "active" }], activePath: [{ title: "Verify", status: "active", path: "2" }, { title: "Run tests", status: "active", path: "2.1.1" }] } }));
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
			["detail", renderDetail(ctx, width, 40, new TextPane()).lines],
			["usage", renderUsage(ctx, width, 30, "today", "cost")],
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
	assert.match(overview, /PLAN {3}Ship it ▸ Verify ▸ Run tests/);
	assert.match(overview, /anthropic 5h/);
	assert.match(overview, /CTX/);
	assert.match(overview, /Run tests +83% /, "context fill sits beside the plan");
});

test("a highlighted row keeps its background across truncated cells", () => {
	const ctx = context();
	ctx.selected = ctx.store.rows.get(104);
	const background = theme.selected("x").split("x")[0];
	const line = renderOverview(ctx, 80, 30).find((text) => strip(text).includes("a very long")) ?? "";
	assert.ok(line.includes("\x1b[0m"), "the long name is truncated");
	for (const rest of line.split("\x1b[0m").slice(1)) assert.ok(rest.startsWith(background), "the background resumes after each reset");
});

test("the overview previews the selected session's latest reply in the rows the table leaves free", () => {
	const ctx = context();
	const plan = { title: "Ship it", lifecycle: "active", complete: 1, total: 2, blocked: 0, milestones: [], activePath: [] };
	ctx.store.setState(101, state(101, { plan, lastPrompt: "Ship it", suggestion: "Run the tests", lastSaid: Array.from({ length: 60 }, (_, index) => `reply line ${index + 1}`).join("\n") }));
	ctx.selected = ctx.store.rows.get(101);
	const lines = renderOverview(ctx, 100, 30).map(strip);
	assert.equal(lines.length, 29, "the preview fills the view");
	const first = lines.findIndex((line) => /^ SAID +reply line 1 /.test(line));
	assert.ok(first > 0);
	assert.match(lines[first - 1], /^ PROMPT +"Ship it"/, "the prompt comes before the reply");
	assert.match(lines.at(-1) ?? "", /^ NEXT +"Run the tests"/, "the suggested next prompt comes last");
	const shown = lines.length - 1 - first;
	assert.match(lines.at(-2) ?? "", new RegExp(`^ ▼ ${60 - shown} +reply line ${shown} `));
});

test("plan counts with three digits are shown whole", () => {
	const ctx = context();
	ctx.store.setState(101, state(101, { plan: { title: "Big plan", lifecycle: "active", complete: 92, total: 100, blocked: 0, milestones: [], activePath: [{ title: "Assess", status: "active" }] } }));
	ctx.selected = ctx.store.rows.get(101);
	for (const width of [80, 100, 150]) {
		assert.match(strip(renderOverview(ctx, width, 30).join("\n")), /^ PLAN .*[▰▱] 92\/100 *$/m, `at ${width} columns`);
	}
});

test("overview sparklines share one scale, so an idle session does not look busy", () => {
	const ctx = context();
	const load = (pid: number, cores: number) => {
		const row = ctx.store.rows.get(pid);
		assert.ok(row);
		for (let index = 0; index < 60; index++) {
			row.cpuDirect.push(cores);
			row.cpuIndirect.push(0);
		}
		row.resources = { directCpu: cores, indirectCpu: 0, directMem: 1e8, indirectMem: 0, directGpuMem: 0, indirectGpuMem: 0, consumers: [], background: [] };
	};
	load(101, 2.5);
	load(102, 0.1);
	const overview = strip(renderOverview(ctx, 120, 30).join("\n"));
	const spark = (cores: string) => new RegExp(`(\\S{5}) +${cores.replace(".", "\\.")}c`).exec(overview)?.[1];
	assert.equal(spark("2.5"), "█████");
	assert.equal(spark("0.1"), "▁▁▁▁▁");
});

test("detail charts have a floor, so small, flat use does not fill them", () => {
	const ctx = context();
	const row = ctx.store.rows.get(101);
	assert.ok(row);
	for (let index = 0; index < 30; index++) {
		row.cpuDirect.push(0.4);
		row.cpuIndirect.push(0);
		row.memDirect.push(438 * 1024 ** 2);
		row.memIndirect.push(0);
	}
	ctx.selected = row;
	const detail = strip(renderDetail(ctx, 120, 40, new TextPane()).lines.join("\n"));
	assert.match(detail, /1\.0c┤/);
	assert.match(detail, /4\.0G┤/);
});

test("at 80×24 the detail view still shows SAID, NEXT and the activity lane", () => {
	const ctx = context();
	ctx.store.setState(101, state(101, { lastSaid: "Done.", suggestion: "Run the tests", tools: Array.from({ length: 8 }, (_, index) => ({ id: String(index), name: "bash", detail: `step ${index}`, startedAt: Date.now() - 1000, endedAt: Date.now() })) }));
	ctx.selected = ctx.store.rows.get(101);
	const lines = renderDetail(ctx, 80, 24, new TextPane()).lines.map(strip);
	assert.equal(lines.length, 23);
	assert.ok(lines.some((line) => /^ SAID +Done\./.test(line)));
	assert.match(lines.at(-2) ?? "", /^ NEXT +"Run the tests"/);
	assert.match(lines.at(-1) ?? "", /^ 60m /);


	const tall = renderDetail(ctx, 120, 50, new TextPane()).lines.map(strip);
	const tools = tall.filter((line) => /^( TOOLS)? +✔ bash +step \d/.test(line));
	assert.equal(tools.length, 6, "a tall terminal lists up to six tool runs");
	assert.match(tools[0], /step 7/, "newest first");

	ctx.store.setState(101, state(101, { lastSaid: "Done.", suggestion: "Run the tests", lastSettledAt: Date.now(), lastError: { message: "529 overloaded", at: Date.now() } }));
	const withError = renderDetail(ctx, 80, 24, new TextPane()).lines.map(strip);
	assert.ok(withError.some((line) => /^ ERROR +529 overloaded/.test(line)));
	assert.match(withError.at(-1) ?? "", /^ 60m /, "an ERROR line costs a chart row, not the lane");
});

test("background jobs and subagents show as a BG badge on wide terminals and as a list for the selected session", () => {
	const ctx = context();
	const row = ctx.store.rows.get(101);
	assert.ok(row);
	const now = Date.now();
	row.resources = {
		directCpu: 0.1,
		indirectCpu: 0,
		directMem: 1e8,
		indirectMem: 0,
		directGpuMem: 0,
		indirectGpuMem: 0,
		consumers: [],
		background: [
			{ kind: "job", label: "nightly-build", startedAt: now - 12 * 60_000 },
			{ kind: "subagent", label: "coder", startedAt: now - 3 * 60_000 },
		],
	};
	ctx.selected = row;
	const wide = strip(renderOverview(ctx, 150, 40).join("\n"));
	assert.match(wide, / BG +\$/m);
	assert.match(wide, /^▌1 project-101 .* 1j 1s +4\.20 $/m);
	assert.match(wide, /^ BG +job nightly-build 12m {2}· {2}subagent coder 3m00s/m);
	assert.doesNotMatch(strip(renderOverview(ctx, 120, 40).join("\n")), / BG +\$/m, "no column when PLAN needs the room");
	assert.match(strip(renderDetail(ctx, 120, 40, new TextPane()).lines.join("\n")), /^ BG +job nightly-build/m);
});

test("sessions on models without a price show tokens instead of an empty cost", () => {
	const ctx = context();
	const hour = String(Math.floor(Date.now() / 3_600_000));
	ctx.store.setState(102, state(102, { lastSettledAt: Date.now(), usage: { direct: { ...emptyUsage(), tokens: 172_600_000 }, indirect: emptyUsage() } }));
	ctx.quota.windows.push({ provider: "openai-codex-account-2", providerLabel: "codex#2", label: "wk", usedPercent: 3, resetAt: Date.now() + 3_600_000, windowSeconds: 604800, fetchedAt: Date.now() });
	ctx.usage.apply({
		type: "update",
		scanned: true,
		durationMs: 0,
		removed: [],
		changed: [
			{ path: "/a.jsonl", kind: "session", sessionId: "session-102", cwd: "/home/user/dev/project-102", size: 1, mtimeMs: 1, offset: 1, hours: { [hour]: { "openai-codex-account-2/gpt-6": { tokens: 4e6, cost: 0, cacheRead: 0, prompt: 0 }, "openai-codex/gpt-6": { tokens: 1e6, cost: 0, cacheRead: 0, prompt: 0 } } } },
			{ path: "/b.jsonl", kind: "session", sessionId: "session-101", cwd: "/home/user/dev/project-101", size: 1, mtimeMs: 1, offset: 1, hours: { [hour]: { "anthropic/opus": { tokens: 2e6, cost: 3, cacheRead: 0, prompt: 0 } } } },
		],
	});

	assert.match(strip(renderOverview(ctx, 120, 30).join("\n")), /^ 2 project-102 .* 173Mt $/m);
	ctx.selected = ctx.store.rows.get(102);
	const detail = strip(renderDetail(ctx, 120, 40, new TextPane()).lines.join("\n"));
	assert.match(detail, /direct +█+ 173M tok/);
	assert.match(detail, /total 173M tok/);

	const cost = strip(renderUsage(ctx, 140, 30, "today", "cost").join("\n"));
	assert.match(cost, /codex#2 +wk .* 2 project-102/, "the unpriced window's share is weighted by tokens");
	assert.doesNotMatch(cost, /^2 project-102 /m, "cost lists only priced sessions");
	const tokens = strip(renderUsage(ctx, 140, 30, "today", "tokens").join("\n"));
	assert.match(tokens, /TOKENS BY SESSION/);
	assert.match(tokens, /^2 project-102 +█+ +5\.0M/m);
	assert.match(tokens, /gpt-6 +█+ +71% +5\.0M/, "one model through two accounts is one row");
});

test("the usage view keeps providers and sessions apart", () => {
	const ctx = context();
	const hour = String(Math.floor(Date.now() / 3_600_000));
	const bucket = (cost: number) => ({ tokens: cost * 1000, cost, cacheRead: 0, prompt: 0 });
	ctx.usage.apply({
		type: "update",
		scanned: true,
		durationMs: 0,
		removed: [],
		changed: [
			{ path: "/open.jsonl", kind: "session", sessionId: "session-101", cwd: "/home/user/dev/project-101", size: 1, mtimeMs: 1, offset: 1, hours: { [hour]: { "anthropic/opus": bucket(3) } } },
			{ path: "/ended.jsonl", kind: "session", sessionId: "ended", cwd: "/home/user/dev/project-101", firstPrompt: "Fix the bug", size: 1, mtimeMs: 1, offset: 1, hours: { [hour]: { "anthropic/opus": bucket(2) } } },
		],
	});
	const usage = strip(renderUsage(ctx, 140, 30, "today", "cost").join("\n"));
	assert.match(usage, /anthropic 5h/);
	assert.match(usage, /1 project-101 {2}project-101 › Fix the bug/, "the share legend tells the sessions apart");
	assert.match(usage, /^1 project-101 +█+ +3\.00/m);
	assert.match(usage, /^project-101 › Fix the bug +█+[▏▎▍▌▋▊▉]? +2\.00/m);
});

test("detail shows the whole reply in a scrollable SAID pane, then the suggested next prompt", () => {
	const ctx = context();
	const said = Array.from({ length: 60 }, (_, index) => `reply line ${index + 1}`).join("\n");
	ctx.store.setState(101, state(101, { lastSaid: said, suggestion: "Run the full test suite\nand report" }));
	ctx.selected = ctx.store.rows.get(101);
	const pane = new TextPane();
	const render = () => {
		const view = renderDetail(ctx, 100, 40, pane);
		assert.equal(view.lines.length, 39);
		assert.ok(view.said && view.said.height > 2, "SAID gets the free rows");
		const lines = view.lines.map(strip);
		return { said: lines.slice(view.said.top, view.said.top + view.said.height), after: lines[view.said.top + view.said.height] };
	};

	const top = render();
	assert.match(top.said[0], /^ SAID +reply line 1 /);
	assert.match(top.said.at(-1) ?? "", new RegExp(`^ ▼ ${60 - top.said.length} +reply line ${top.said.length} `));
	assert.match(top.after, /^ NEXT +"Run the full test suite and report"/);

	pane.page(1);
	const paged = render();
	assert.match(paged.said[0], new RegExp(`^ SAID +reply line ${top.said.length} `), "a page keeps one line of context");
	assert.match(paged.said[1], new RegExp(`^ ▲ ${top.said.length - 1} +reply line`));

	pane.scrollTo("end");
	const end = render();
	assert.match(end.said.at(-1) ?? "", /^ +reply line 60 /, "nothing below the end");
});

test("the ask view fills 80×24 and 150×45 with the newest answer in view, and keeps a scrolled-up position as answers grow", () => {
	const now = Date.now();
	const usage = { ...emptyUsage(), input: 4, cacheRead: 76_600, cacheWrite: 396, output: 300, tokens: 77_300, cost: 0.0231 };
	const long = Array.from({ length: 40 }, (_, index) => `- finding ${index + 1}`).join("\n");
	let asks: AskRun[] = [
		{ id: 1, question: "What changed?", askedAt: now - 2 * 86_400_000, status: "answered", answer: `# Summary\n\n${long}`, usage },
		{ id: 2, question: "Why did it fail?", askedAt: now - 120_000, status: "failed", answer: "", error: "prompt is too long" },
		{ id: 3, question: "What are you doing now?", askedAt: now - 2000, status: "answering", answer: "Running npm test" },
	];
	for (const [width, height] of [[80, 24], [150, 45]]) {
		const tui = { terminal: { rows: height, columns: width }, requestRender: () => {} } as unknown as TUI;
		const view = new AskView(tui, { target: "1 proj", asks: () => asks, height: () => height, onAsk: async () => {}, onClose: () => {} });
		const lines = view.render(width);
		assert.equal(lines.length, height, `${width}×${height} height`);
		for (const line of lines) assert.equal(visibleWidth(line), width, `${width}×${height} width`);
		const text = lines.map(strip);
		assert.match(text[0], /ask · 1 proj/);
		assert.match(text.at(-1) ?? "", /⏎ ask.*PgUp PgDn scroll.*Esc close/);
		const body = text.join("\n");
		assert.match(body, /What are you doing now\?[\s\S]*Running npm test[\s\S]*answering…/, "the newest ask is in view");
		assert.match(body, /● answering · the next question waits for this answer/);

		view.handleInput("\x1b[5~");
		const scrolled = view.render(width).slice(1, -1);
		assert.doesNotMatch(scrolled.map(strip).join("\n"), /Running npm test/, "PgUp leaves the newest answer");
		asks = asks.map((ask) => (ask.id === 3 ? { ...ask, answer: "Running npm test, then the linter" } : ask));
		assert.deepEqual(view.render(width).slice(1, -1), scrolled, "a growing answer does not move a scrolled-up thread");
		asks = asks.map((ask) => (ask.id === 3 ? { ...ask, answer: "Running npm test" } : ask));
	}
	const tui = { terminal: { rows: 24, columns: 80 }, requestRender: () => {} } as unknown as TUI;
	const failed = new AskView(tui, { target: "1 proj", asks: () => asks.slice(0, 2), height: () => 24, onAsk: async () => {}, onClose: () => {} });
	assert.match(failed.render(80).map(strip).join("\n"), /Why did it fail\?[\s\S]*✖ prompt is too long/);
});
