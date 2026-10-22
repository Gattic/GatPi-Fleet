import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { sessionDirName } from "../src/manager/actions/sessions.ts";
import type { GitOperationResult, GitService, GitSummary } from "../src/manager/actions/git.ts";
import { GpuMonitor } from "../src/manager/collectors/gpu.ts";
import { HermesAdvisor, type HermesAdvisorClient, type HermesFeedbackEvent, type HermesSnapshot } from "../src/dashboard/hermes/advisor.ts";
import { QuotaMonitor } from "../src/manager/collectors/quota.ts";
import { type SessionRow, Store } from "../src/manager/model/store.ts";
import type { Network } from "../src/manager/network.ts";
import type { RemoteHost } from "../src/manager/remote/host.ts";
import type { RelayOp, RelayOps } from "../src/relay/protocol.ts";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import type { InterruptedSession } from "../src/manager/recovery.ts";
import { Sessions } from "../src/server/sessions.ts";
import { App } from "../src/dashboard/ui/app.ts";
import { COMMIT_REVIEW_PROMPT } from "../src/manager/actions/git.ts";
import { roadmapFixture } from "../scripts/roadmap-fixture.ts";
import { UsageIndex } from "../src/manager/usage/usage-index.ts";
import { type Command, emptyUsage, type SessionState } from "../src/protocol/index.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch (error) {
			last = error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	if (last) throw last;
}

function readLedger(path: string): HermesFeedbackEvent[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as HermesFeedbackEvent);
}

/** App with a terminal-free TUI stand-in: keys go to the top overlay, like pi-tui's overlay focus. */
function cleanGitSummary(overrides: Partial<GitSummary> = {}): GitSummary {
	return { cwd: "/home/user/dev/proj", root: "/home/user/dev/proj", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, remotes: ["origin"], ...overrides };
}

function gitStub(summary: GitSummary = cleanGitSummary()) {
	const calls: string[] = [];
	const ok = async (): Promise<GitOperationResult> => ({ stdout: "", stderr: "" });
	const service: GitService = {
		getSummary: async () => summary,
		listBranches: async () => [
			{ name: "main", current: summary.branch === "main", upstream: "origin/main" },
			{ name: "feature", current: summary.branch === "feature", upstream: "origin/feature" },
		],
		status: async () => "On branch main\nChanges not staged for commit:\n\tmodified:   README.md\n",
		pull: async () => {
			calls.push("pull");
			return ok();
		},
		push: async () => {
			calls.push("push");
			return ok();
		},
		pushSetUpstream: async (_cwd, remote) => {
			calls.push(`push-upstream:${remote}`);
			return ok();
		},
		switchBranch: async (_cwd, branch) => {
			calls.push(`switch:${branch}`);
			return ok();
		},
	};
	return { service, calls };
}

function harness(sessionRoot: string, advisor?: HermesAdvisorClient, git: GitService = gitStub().service, remotes = new Map<string, RemoteHost>()) {
	const overlays: Component[] = [];
	const tui = {
		terminal: { rows: 40, columns: 120 },
		showOverlay: (component: Component) => {
			overlays.push(component);
			return {
				hide: () => {
					const index = overlays.indexOf(component);
					if (index >= 0) overlays.splice(index, 1);
				},
			};
		},
		setFocus: () => {},
		requestRender: () => {},
	} as unknown as TUI;
	const sent: Command[] = [];
	const network = { remotes, remote: (host: string) => remotes.get(host), isConnected: () => true, send: async (_row: SessionRow, command: Command) => void sent.push(command) } as unknown as Network;
	const store = new Store(() => {});
	const feedback: HermesFeedbackEvent[] = [];
	const advisorService = advisor ?? {
		review: async (snapshot: HermesSnapshot) => ({ generatedAt: Date.now(), snapshotAt: snapshot.generatedAt, source: "local" as const, cards: [], feedbackSummary: [] }),
		recordFeedback: async (event: HermesFeedbackEvent) => void feedback.push(event),
	};
	let quits = 0;
	const interrupted: InterruptedSession[] = [];
	const resumed: InterruptedSession[] = [];
	const dismissed: InterruptedSession[] = [];
	let recoveryError: Error | undefined;
	const app = new App({
		tui,
		store,
		network,
		usage: new UsageIndex({ sessionRoot, cachePath: "", retentionMs: 0, onUpdate: () => {} }),
		quota: new QuotaMonitor("/nonexistent", "/nonexistent"),
		gpu: new GpuMonitor(),
		advisor: advisorService,
		git,
		dismiss: async (row) => { store.dismiss(row.key); },
		interruptedSessions: () => interrupted,
		resumeInterrupted: async (entry) => {
			if (recoveryError) throw recoveryError;
			resumed.push(entry);
			return "pi-recovered";
		},
		dismissInterrupted: async (entry) => {
			dismissed.push(entry);
			interrupted.splice(interrupted.indexOf(entry), 1);
		},
		sessionRoot,
		runtimeDir: "/nonexistent",
		quit: () => quits++,
	});
	return {
		app,
		store,
		interrupted, resumed, dismissed,
		failRecovery: (error: Error) => { recoveryError = error; },
		sent,
		quits: () => quits,
		feedback,
		press: (...keys: string[]) => {
			for (const key of keys) {
				const target = overlays.at(-1) ?? app;
				assert.ok(target.handleInput, "focused component takes input");
				target.handleInput(key);
			}
		},
		dialog: () => (overlays.length ? strip(overlays.at(-1)!.render(80).join("\n")) : undefined),
	};
}

const interruptedSession: InterruptedSession = {
	version: 1, pid: 42, instanceId: "crashed-run", processIdentity: "boot:123", sessionId: "saved-id",
	sessionFile: "/custom/saved.jsonl", cwd: "/projects/work", name: "Recover this work", startedAt: 100,
};

test("interrupted sessions are suggested even with no live rows; resume is explicit and failure keeps the suggestion", async () => {
	const ui = harness("/nonexistent");
	ui.interrupted.push({ ...interruptedSession });
	assert.match(strip(ui.app.render(120).join("\n")), /1 interrupted session.*e to review/);
	ui.press("e");
	assert.match(ui.dialog() ?? "", /Recover this work.*saved-id/);
	ui.press("\r", "\r");
	assert.match(ui.dialog() ?? "", /pi --session \/custom\/saved.jsonl/);
	assert.deepEqual(ui.resumed, [], "opening the suggestion does not launch");
	ui.press("n");
	assert.deepEqual(ui.resumed, []);
	ui.failRecovery(new Error("saved file missing"));
	ui.press("e", "\r", "\r", "y");
	await eventually(() => assert.match(strip(ui.app.render(120).join("\n")), /recovery failed: saved file missing/));
	assert.equal(ui.interrupted.length, 1);
});

test("interrupted resume targets its exact record and replaces the exited slot after confirmation", async () => {
	const ui = harness("/nonexistent");
	const entry = { ...interruptedSession, host: "box" };
	ui.interrupted.push(entry);
	const state: SessionState = { ...entry, phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] };
	ui.store.setState(entry.pid, state, "box");
	ui.store.disconnect(entry.pid, false, "box");
	ui.press("r");
	assert.match(ui.dialog() ?? "", /box:\/projects\/work/);
	ui.press("y");
	await eventually(() => assert.deepEqual(ui.resumed, [entry]));
	await new Promise((resolve) => setImmediate(resolve));
	ui.store.setState(43, { ...state, pid: 43, instanceId: "new-run", sty: "100.pi-recovered" }, "box");
	assert.equal(ui.store.bySlot(1)?.pid, 43);
	assert.equal(ui.store.rows.has("box:42"), false);
});

test("recovery actions reject newly live ownership and dismissal leaves saved conversations alone", async () => {
	const ui = harness("/nonexistent");
	ui.interrupted.push({ ...interruptedSession });
	ui.press("e", "\r", "\r");
	ui.store.setState(43, { ...interruptedSession, pid: 43, instanceId: "new-run", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	ui.press("y");
	assert.deepEqual(ui.resumed, []);
	assert.match(strip(ui.app.render(120).join("\n")), /already open/);
	ui.press("e", "\r", "\x1b[B", "\r", "y");
	await eventually(() => assert.equal(ui.dismissed.length, 1));
	assert.equal(ui.interrupted.length, 0);
});

test("quit asks first while a close-and-restart is waiting for its session to exit", () => {
	const ui = harness("/nonexistent");
	const now = Date.now();
	ui.store.setState(101, { pid: 101, cwd: "/home/user/dev/proj", sessionId: "s", instanceId: "instance", phase: "working", phaseSince: now, lastEventAt: now, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });

	ui.press("C");
	assert.match(ui.dialog() ?? "", /Close and start a fresh session/);
	ui.press("y");
	assert.deepEqual(ui.sent, [{ kind: "shutdown" }]);

	ui.press("q");
	assert.match(ui.dialog() ?? "", /Close-and-restart is still pending for proj.*Quit anyway\?/s);
	ui.press("n");
	assert.equal(ui.dialog(), undefined);
	assert.equal(ui.quits(), 0);

	ui.press("\x03", "y"); // Ctrl-c takes the same path as q
	assert.equal(ui.quits(), 1);
});

test("Roadmap Viewer opens for the selected remote session, follows updates, labels disconnects and guards reload identity", () => {
	const ui = harness("/nonexistent");
	const state: SessionState = { pid: 101, cwd: "/work", sessionId: "s", instanceId: "instance", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [], plan: roadmapFixture() };
	ui.store.setState(101, state, "box");
	ui.press("o");
	assert.match(ui.dialog() ?? "", /Roadmap Viewer · live · work@box/);
	assert.match(ui.dialog() ?? "", /Phone viewer/);
	ui.store.setState(101, { ...state, plan: { ...state.plan!, lifecycle: "shelved" } }, "box");
	assert.match(ui.dialog() ?? "", /Lifecycle: shelved/);
	ui.store.disconnect(101, true, "box");
	assert.match(ui.dialog() ?? "", /Last known roadmap/);
	assert.match(ui.dialog()?.split("\n")[0] ?? "", /last known/, "freshness remains in the fixed title when scrolled");
	ui.store.setState(101, { ...state, instanceId: "replacement" }, "box");
	assert.match(ui.dialog() ?? "", /Session ended or reloaded/);
	ui.press("q");
	assert.equal(ui.dialog(), undefined);
	assert.equal(ui.quits(), 0, "q closes only the viewer");
	assert.deepEqual(ui.sent, [], "viewing sends no commands or model prompts");
	ui.press("\r", "o");
	assert.match(ui.dialog() ?? "", /Phone viewer/, "viewer is reachable from detail as well as overview");
});

test("Roadmap Viewer handles no selection, unpublished plans and plan clearing", () => {
	const ui = harness("/nonexistent");
	ui.press("o");
	assert.match(strip(ui.app.render(120).join("\n")), /No session selected/);
	const state: SessionState = { pid: 101, cwd: "/work", sessionId: "s", instanceId: "instance", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] };
	ui.store.setState(101, state);
	ui.press("o");
	assert.match(ui.dialog() ?? "", /No roadmap published/);
	ui.store.setState(101, { ...state, plan: roadmapFixture() });
	assert.match(ui.dialog() ?? "", /Phone viewer/);
	ui.store.setState(101, state);
	assert.match(ui.dialog() ?? "", /No roadmap published/);
	ui.press("\x1b");
	assert.equal(ui.dialog(), undefined);
	assert.deepEqual(ui.sent, []);
});

test("quit without pending work does not ask", () => {
	const ui = harness("/nonexistent");
	ui.press("q");
	assert.equal(ui.dialog(), undefined);
	assert.equal(ui.quits(), 1);
});

test("resume refuses unknown session-file ownership without an unsafe override", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-app-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "proj");
	mkdirSync(cwd);
	const sessionDir = join(root, "sessions", sessionDirName(cwd));
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: new Date().toISOString(), cwd })}\n`);
	// A regression would try to launch screen; keep it off PATH so the test never starts pi.
	const path = process.env.PATH;
	process.env.PATH = "";
	t.after(() => {
		process.env.PATH = path;
	});

	const ui = harness(join(root, "sessions"));
	ui.store.applySample({ resources: new Map(), piProcesses: [{ pid: 202, startedAt: Date.now(), cwd }], host: { cpu: 0, cores: 1, memUsed: 0, memTotal: 1, load1: 0 } }, undefined, Date.now());

	ui.press("r");
	assert.match(ui.dialog() ?? "", /Resume in/);
	ui.press("\r");
	assert.equal(ui.dialog(), undefined);
	assert.match(strip(ui.app.render(120).at(-1) ?? ""), /session file ownership is unknown/);
	assert.doesNotMatch(strip(ui.app.render(120).at(-1) ?? ""), /started|launch failed/);
});

test("the phone's project list is the n picker's: open projects first, then most recently active", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-projects-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	const path = (name: string) => join(root, name);
	const history = (name: string, minutesAgo: number) => {
		const dir = join(agent, "sessions", sessionDirName(path(name)));
		const file = join(dir, "a.jsonl");
		mkdirSync(path(name), { recursive: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: path(name) })}\n`);
		const at = (Date.now() - minutesAgo * 60_000) / 1000;
		utimesSync(file, at, at);
	};
	history("open-1", 60);
	history("open-2", 180);
	history("closed-1", 30);
	history("exited", 240);
	history("closed-2", 300);
	mkdirSync(path("open-new"));
	// The dashboard and the gateway are separate processes whose stores see sessions in different orders.
	const live = [[201, "open-2"], [202, "open-new"], [203, "open-1"], [204, "exited"]] as const;
	const ui = harness(join(agent, "sessions"));
	const runtime = new ManagerRuntime({ agent, runtimeDir: join(root, "run"), cacheDir: join(root, "cache") });
	t.after(() => runtime.close());
	for (const [store, order] of [[ui.store, live], [runtime.store, [...live].reverse()]] as const) {
		for (const [pid, name] of order) store.setState(pid, session({ pid, cwd: path(name), instanceId: `i${pid}` }));
		store.bye(204, "quit");
	}

	const lists = async (expected: string[]) => {
		ui.press("n");
		const picker = (ui.dialog() ?? "").split("\n").flatMap((line) => expected.filter((p) => line.includes(p)));
		ui.press("\x1b");
		assert.deepEqual(picker, expected, "dashboard n picker");
		assert.deepEqual((await new Sessions(runtime).projects()).projects.map((p) => p.path), expected, "gateway /api/v1/projects");
	};

	await lists(["open-1", "open-2", "open-new", "closed-1", "exited", "closed-2"].map(path));
	history("open-2", 10); // new activity in the other open project moves it ahead
	await lists(["open-2", "open-1", "open-new", "closed-1", "exited", "closed-2"].map(path));
});

function session(overrides: Partial<SessionState>): SessionState {
	const now = Date.now();
	return { pid: 101, cwd: "/home/user/dev/proj", sessionId: "s", instanceId: "instance", phase: "idle", phaseSince: now, lastEventAt: now, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [], ...overrides };
}

test("Hermes advisor shows action cards and confirms an ask action", async () => {
	const feedback: HermesFeedbackEvent[] = [];
	const advisor: HermesAdvisorClient = {
		review: async (snapshot) => ({
			generatedAt: Date.now(),
			snapshotAt: snapshot.generatedAt,
			source: "hermes",
			feedbackSummary: [],
			cards: [
				{
					id: "hermes_stalled",
					severity: "warning",
					title: "Ask about the blocker",
					body: "Hermes thinks the selected session should explain its blocker.",
					evidence: ["Session is waiting on the operator."],
					source: "hermes",
					targetSession: "101",
					targetLabel: "proj",
					action: { kind: "ask", session: "101", question: "What is blocking you?" },
				},
			],
		}),
		recordFeedback: async (event) => void feedback.push(event),
	};
	const ui = harness("/nonexistent", advisor);
	ui.store.setState(101, session({ lastSettledAt: Date.now() - 10_000 }));

	ui.press("H");
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(ui.dialog() ?? "", /Hermes advisor[\s\S]*Ask about the blocker[\s\S]*ask session/);
	ui.press("\r");
	assert.match(ui.dialog() ?? "", /Ask proj: "What is blocking you\?"\?/);
	ui.press("y");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(ui.sent, [{ kind: "ask", question: "What is blocking you?" }]);
	assert.deepEqual(feedback.map((event) => event.kind), ["shown", "accepted", "executed"]);
});

test("Hermes advisor TUI smoke covers refresh, dismiss, confirmed notify, ledger, and fallback", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-hermes-smoke-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const fakeHermes = join(root, "fake-hermes");
	writeFileSync(
		fakeHermes,
		`#!/usr/bin/env node
console.log(JSON.stringify({cards:[
  {id:"dismiss-me",severity:"info",title:"Dismiss this card",body:"A scripted card used by the smoke test.",evidence:["fake hermes"],action:{kind:"memory_proposal",text:"Ignore this scripted smoke card."}},
  {id:"notify",severity:"suggestion",title:"Smoke notify",body:"Confirming this card should only show a dashboard notification.",evidence:["fake hermes"],action:{kind:"notify",message:"Hermes smoke notification"}}
]}));
`,
	);
	chmodSync(fakeHermes, 0o755);

	const ledgerPath = join(root, "events.jsonl");
	const ui = harness("/nonexistent", new HermesAdvisor({ ledgerPath, command: fakeHermes, timeoutMs: 1000 }));
	ui.store.setState(101, session({ lastSettledAt: Date.now() - 10_000, suggestion: "Run the smoke check" }));

	ui.press("H");
	await eventually(() => assert.match(ui.dialog() ?? "", /Hermes advisor[\s\S]*Dismiss this card[\s\S]*Smoke notify/));
	ui.press("r");
	await eventually(() => assert.match(ui.dialog() ?? "", /Hermes[\s\S]*Dismiss this card[\s\S]*Smoke notify/));
	ui.press("d");
	assert.doesNotMatch(ui.dialog() ?? "", /Dismiss this card/);
	assert.match(ui.dialog() ?? "", /Smoke notify/);
	ui.press("\r");
	assert.match(ui.dialog() ?? "", /Show notification: "Hermes smoke notification"\?/);
	ui.press("y");
	await eventually(() => {
		const events = readLedger(ledgerPath);
		assert.equal(events.filter((event) => event.kind === "shown").length, 4);
		assert.ok(events.some((event) => event.kind === "dismissed" && event.cardTitle === "Dismiss this card"));
		assert.ok(events.some((event) => event.kind === "accepted" && event.actionKind === "notify"));
		assert.ok(events.some((event) => event.kind === "executed" && event.actionKind === "notify"));
	});
	assert.match(strip(ui.app.render(120).join("\n")), /Hermes smoke notification/);

	const fallbackLedger = join(root, "fallback-events.jsonl");
	const fallback = harness("/nonexistent", new HermesAdvisor({ ledgerPath: fallbackLedger, command: join(root, "missing-hermes"), timeoutMs: 1000 }));
	fallback.store.setState(101, session({ lastSettledAt: Date.now() - 10_000, suggestion: "Use the local fallback card" }));
	fallback.press("H");
	await eventually(() => {
		const dialog = fallback.dialog() ?? "";
		assert.match(dialog, /local rules/);
		assert.match(dialog, /has a next prompt ready/);
		assert.match(dialog, /ENOENT/);
	});
	await eventually(() => {
		const events = readLedger(fallbackLedger);
		assert.ok(events.some((event) => event.kind === "shown" && event.source === "local" && event.actionKind === "prompt"));
	});
});

test("Git menu confirms update/pull and send/push actions", async () => {
	const git = gitStub(cleanGitSummary({ ahead: 1 }));
	const ui = harness("/nonexistent", undefined, git.service);
	ui.store.setState(101, session({}));

	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /Git · proj[\s\S]*main → origin\/main[\s\S]*ahead 1[\s\S]*u update \(pull --ff-only\)[\s\S]*s send \(push\)/));
	ui.press("u");
	assert.match(ui.dialog() ?? "", /Run git pull --ff-only/);
	assert.deepEqual(git.calls, []);
	ui.press("y");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(git.calls, ["pull"]);

	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /Git · proj/));
	ui.press("s");
	assert.match(ui.dialog() ?? "", /Run git push and publish main \(1 ahead\) to origin\/main\?/);
	ui.press("y");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(git.calls, ["pull", "push"]);
});

test("Git push offers upstream creation when one remote is available", async () => {
	const git = gitStub(cleanGitSummary({ upstream: undefined }));
	const ui = harness("/nonexistent", undefined, git.service);
	ui.store.setState(101, session({}));

	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /push will offer to create upstream origin\/main/));
	ui.press("s");
	assert.match(ui.dialog() ?? "", /git push -u origin HEAD/);
	ui.press("y");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(git.calls, ["push-upstream:origin"]);
});

test("Git blocks pull and push from detached HEAD", async () => {
	const git = gitStub(cleanGitSummary({ branch: undefined, headOid: "abcdef1234567890", upstream: undefined }));
	const ui = harness("/nonexistent", undefined, git.service);
	ui.store.setState(101, session({}));

	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /detached abcdef123456/));
	ui.press("u");
	assert.match(strip(ui.app.render(120).join("\n")), /Cannot pull from detached HEAD/);
	ui.press("s");
	assert.match(strip(ui.app.render(120).join("\n")), /Cannot push from detached HEAD/);
	assert.deepEqual(git.calls, []);
});

test("Git blocks pull and push when no upstream or remote is configured", async () => {
	const git = gitStub(cleanGitSummary({ upstream: undefined, remotes: [] }));
	const ui = harness("/nonexistent", undefined, git.service);
	ui.store.setState(101, session({}));

	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /main · no upstream/));
	ui.press("u");
	assert.match(strip(ui.app.render(120).join("\n")), /No upstream is configured; set one in git first/);
	ui.press("s");
	assert.match(strip(ui.app.render(120).join("\n")), /No upstream is configured; set one in git first/);
	assert.deepEqual(git.calls, []);
});

test("Git branch switching requires a clean tree and confirms the target branch", async () => {
	const dirty = gitStub(cleanGitSummary({ unstaged: 1 }));
	const blocked = harness("/nonexistent", undefined, dirty.service);
	blocked.store.setState(101, session({}));
	blocked.press("g");
	await eventually(() => assert.match(blocked.dialog() ?? "", /tree 1 changed/));
	blocked.press("b");
	assert.match(strip(blocked.app.render(120).join("\n")), /Working tree has changes; ask the agent to review, commit, or stash first/);
	assert.deepEqual(dirty.calls, []);

	const clean = gitStub(cleanGitSummary());
	const ui = harness("/nonexistent", undefined, clean.service);
	ui.store.setState(101, session({}));
	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /Git · proj/));
	ui.press("b");
	await eventually(() => assert.match(ui.dialog() ?? "", /Switch branch in/));
	ui.press("\x1b[B", "\r");
	assert.match(ui.dialog() ?? "", /Switch proj from main to feature\?/);
	ui.press("y");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(clean.calls, ["switch:feature"]);
});

test("Git status and command failures are reported", async () => {
	const statusFailure = gitStub();
	statusFailure.service.getSummary = async () => {
		throw new Error("not a git repository");
	};
	const broken = harness("/nonexistent", undefined, statusFailure.service);
	broken.store.setState(101, session({}));
	broken.press("g");
	await eventually(() => assert.match(broken.dialog() ?? "", /not a git repository/));
	broken.press("c");
	assert.match(strip(broken.app.render(120).join("\n")), /Git status has not loaded yet/);
	assert.deepEqual(broken.sent, []);

	const commandFailure = gitStub();
	commandFailure.service.pull = async () => {
		commandFailure.calls.push("pull");
		throw new Error("network failed");
	};
	const ui = harness("/nonexistent", undefined, commandFailure.service);
	ui.store.setState(101, session({}));
	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /Git · proj/));
	ui.press("u");
	assert.match(ui.dialog() ?? "", /Run git pull --ff-only/);
	ui.press("y");
	await eventually(() => assert.match(strip(ui.app.render(120).join("\n")), /network failed/));
	assert.deepEqual(commandFailure.calls, ["pull"]);
});

test("Git status shortcut shows git's own status output; a failure is reported", async () => {
	const ui = harness("/nonexistent");
	ui.store.setState(101, session({}));
	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /v view status/));
	ui.press("v");
	await eventually(() => assert.match(ui.dialog() ?? "", /git status · proj[\s\S]*On branch main[\s\S]*Changes not staged for commit:[\s\S]* {3}modified: {3}README\.md/));
	assert.doesNotMatch(ui.dialog() ?? "", /\t/, "tabs are expanded");
	ui.press("\x1b");
	assert.equal(ui.dialog(), undefined);

	const failing = gitStub();
	failing.service.status = async () => {
		throw new Error("not a git repository");
	};
	const broken = harness("/nonexistent", undefined, failing.service);
	broken.store.setState(101, session({}));
	broken.press("g");
	await eventually(() => assert.match(broken.dialog() ?? "", /Git · proj/));
	broken.press("v");
	await eventually(() => assert.match(strip(broken.app.render(120).join("\n")), /not a git repository/));
	assert.match(broken.dialog() ?? "", /Git · proj/, "the Git menu stays open");
});

test("a slow git status or branch list does not replace what the user moved on to", async () => {
	for (const key of ["v", "b"]) {
		let finish: () => void = () => assert.fail(`${key} did not run git`);
		const slow = gitStub();
		slow.service.status = () =>
			new Promise((resolve) => {
				finish = () => resolve("On branch main\n");
			});
		slow.service.listBranches = () =>
			new Promise((resolve) => {
				finish = () => resolve([{ name: "feature", current: false }]);
			});
		const ui = harness("/nonexistent", undefined, slow.service);
		ui.store.setState(101, session({}));
		ui.press("g");
		// Branch switching needs the loaded summary (a clean tree) before it lists branches.
		await eventually(() => assert.match(ui.dialog() ?? "", /tree clean/));
		ui.press(key, "\x1b", "p", ..."half-typed");
		assert.match(ui.dialog() ?? "", /Prompt → 1 proj[\s\S]*half-typed/);

		finish();
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(ui.dialog() ?? "", /Prompt → 1 proj[\s\S]*half-typed/, `${key}: the composer keeps the focus and its text`);
	}
});

test("Git commit shortcut opens the standard AI review prompt", async () => {
	const ui = harness("/nonexistent");
	ui.store.setState(101, session({}));

	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /Git · proj/));
	ui.press("c");
	assert.match(ui.dialog() ?? "", /Prompt → 1 proj[\s\S]*Review the current git changes/);
	ui.press("\r");
	assert.deepEqual(ui.sent.at(-1), { kind: "prompt", text: COMMIT_REVIEW_PROMPT, deliverAs: undefined });

	ui.store.setState(101, session({ phase: "working" }));
	ui.press("g");
	await eventually(() => assert.match(ui.dialog() ?? "", /Git · proj/));
	ui.press("c");
	assert.match(ui.dialog() ?? "", /delivers as follow-up/);
	ui.press("\r");
	assert.deepEqual(ui.sent.at(-1), { kind: "prompt", text: COMMIT_REVIEW_PROMPT, deliverAs: "followUp" });
});

test("the composer offers the suggested next prompt while idle; Tab takes it", () => {
	const ui = harness("/nonexistent");
	ui.store.setState(101, session({ suggestion: "Run the tests\nand report" }));
	ui.press("p");
	assert.match(ui.dialog() ?? "", /↳ Run the tests\s+│\n│ {4}and report/);
	assert.match(ui.dialog() ?? "", /Tab accept suggestion/);
	ui.press("\t");
	assert.doesNotMatch(ui.dialog() ?? "", /↳/, "the editor holds the suggestion now");
	ui.press("\r");
	assert.deepEqual(ui.sent, [{ kind: "prompt", text: "Run the tests\nand report", deliverAs: undefined }]);

	// While working, Tab keeps switching steer / follow-up.
	ui.store.setState(101, session({ phase: "working", suggestion: "Run the tests" }));
	ui.press("p");
	assert.doesNotMatch(ui.dialog() ?? "", /↳/);
	ui.press("\t");
	assert.match(ui.dialog() ?? "", /delivers as follow-up/);
});

test("the latest reply opens full screen with s or a click on SAID, and scrolls in the detail view", () => {
	const ui = harness("/nonexistent");
	const said = `# Done\n\nAll **tests** pass.\n\n${Array.from({ length: 60 }, (_, index) => `- step ${index + 1}`).join("\n")}`;
	ui.store.setState(101, session({ lastSaid: said }));

	ui.press("s");
	assert.match(ui.dialog() ?? "", /said · proj[\s\S]*Done[\s\S]*All tests pass\./);
	assert.match(ui.dialog() ?? "", /1–38\/64/, "full height, with the position");
	ui.press("\x1b[6~");
	assert.match(ui.dialog() ?? "", /27–64\/64/, "PgDn pages, up to the end");
	ui.press("\x1b");
	assert.equal(ui.dialog(), undefined);

	ui.press("\r");
	const saidRow = () => ui.app.render(120).map(strip).findIndex((line) => /^ SAID /.test(line));
	const before = ui.app.render(120).map(strip)[saidRow()];
	ui.press("\x1b[6~");
	assert.notEqual(ui.app.render(120).map(strip)[saidRow()], before, "PgDn scrolls SAID");

	const mouse = (type: TuiMouseEvent["type"], y: number): TuiMouseEvent => ({ type, button: "left", x: 20, y, screenX: 20, screenY: y, width: 120, height: 40, shift: false, alt: false, ctrl: false });
	const row = saidRow();
	assert.equal(ui.app.handleMouse(mouse("click", 0)), undefined, "clicks elsewhere are not ours");
	assert.ok(ui.app.handleMouse(mouse("press", row))?.handled);
	ui.app.handleMouse(mouse("click", row));
	assert.match(ui.dialog() ?? "", /said · proj/);
});

test("Tab walks the sessions that need attention, longest waiting first", () => {
	const ui = harness("/nonexistent");
	const now = Date.now();
	ui.store.setState(101, session({ pid: 101, cwd: "/p/one", lastSettledAt: now - 60_000 }));
	ui.store.setState(102, session({ pid: 102, cwd: "/p/two", lastSettledAt: now - 10_000, lastError: { message: "overloaded", at: now - 10_000 } }));
	ui.store.setState(103, session({ pid: 103, cwd: "/p/three", phase: "working" }));
	ui.store.setState(104, session({ pid: 104, cwd: "/p/four", lastSettledAt: now - 120_000 }));
	const selected = () => /^▌\d (\S+)/.exec(ui.app.render(120).map(strip).find((line) => line.startsWith("▌")) ?? "")?.[1];
	ui.press("3"); // the working session: Tab starts at the longest waiting one
	const walk = Array.from({ length: 4 }, () => {
		ui.press("\t");
		return selected();
	});
	assert.deepEqual(walk, ["four", "one", "two", "four"]);

	ui.store.setState(101, session({ pid: 101, cwd: "/p/one", phase: "working" }));
	ui.store.setState(102, session({ pid: 102, cwd: "/p/two", phase: "working" }));
	ui.store.setState(104, session({ pid: 104, cwd: "/p/four", phase: "working" }));
	ui.press("\t");
	assert.match(strip(ui.app.render(120).at(-1) ?? ""), /No session needs you/);
});

test("M and T switch the model and thinking level; Z compacts after asking, only when idle", () => {
	const ui = harness("/nonexistent");
	ui.store.setState(101, session({ model: "anthropic/opus", thinking: "high", models: ["anthropic/opus", "openai-codex/gpt-6"], context: { tokens: 160_000, window: 200_000, percent: 80 } }));

	ui.press("M");
	assert.match(ui.dialog() ?? "", /Model for proj[\s\S]*opus +anthropic · current[\s\S]*gpt-6 +openai-codex/);
	ui.press("\x1b[B", "\r");
	assert.deepEqual(ui.sent.at(-1), { kind: "model", provider: "openai-codex", id: "gpt-6" });

	ui.press("T");
	assert.match(ui.dialog() ?? "", /high +current/);
	ui.press("\x1b[B", "\x1b[B", "\r");
	assert.deepEqual(ui.sent.at(-1), { kind: "thinking", level: "low" });

	ui.press("Z");
	assert.match(ui.dialog() ?? "", /Compact proj now\? Its context is 80% full\./);
	ui.press("y");
	assert.deepEqual(ui.sent.at(-1), { kind: "compact" });

	ui.store.setState(101, session({ phase: "working" }));
	const sent = ui.sent.length;
	ui.press("Z");
	assert.equal(ui.dialog(), undefined, "no dialog while working");
	assert.match(strip(ui.app.render(120).at(-1) ?? ""), /proj is working; compact it when it is idle/);
	assert.equal(ui.sent.length, sent);
});

test("i asks the selected session a side question; one at a time; an answer that lands unseen is announced", async () => {
	const ui = harness("/nonexistent");
	const asked = Date.now();
	const answering = { id: 7, question: "What are you doing?", askedAt: asked, status: "answering" as const, answer: "Running the" };
	ui.store.setState(101, session({ phase: "working" }));

	ui.press("i");
	assert.match(ui.dialog() ?? "", /ask · 1 proj[\s\S]*Ask this session about its work/);
	ui.press(..."What are you doing?", "\r");
	assert.deepEqual(ui.sent, [{ kind: "ask", question: "What are you doing?" }]);
	// The bridge publishes the new ask before it acknowledges the command.
	ui.store.setState(101, session({ phase: "working", asks: [answering] }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(ui.dialog() ?? "", /What are you doing\?[\s\S]*Running the[\s\S]*answering…/);

	ui.press(..."And then?", "\r");
	assert.equal(ui.sent.length, 1, "a second question waits for the answer");
	assert.match(ui.dialog() ?? "", /And then\?[\s\S]*✖ still answering the previous question|✖ still answering the previous question[\s\S]*And then\?/);

	ui.press("\x1b");
	assert.equal(ui.dialog(), undefined);
	const usage = { ...emptyUsage(), input: 4, cacheRead: 76_600, cacheWrite: 396, output: 300, tokens: 77_300, cost: 0.0231 };
	ui.store.setState(101, session({ phase: "working", asks: [{ ...answering, status: "answered", answer: "Running the tests.", usage }] }));
	ui.app.onTick();
	assert.match(strip(ui.app.render(120).at(-1) ?? ""), /proj answered your question \(i to read it\)/);

	ui.press("i");
	assert.match(ui.dialog() ?? "", /Running the tests\.[\s\S]*ago · 77\.3k tokens, 99% from cache · \$0\.02/);
});

test("an answer that lands while its ask view is open is not announced; a failure shows its reason", async () => {
	const ui = harness("/nonexistent");
	ui.store.setState(101, session({}));
	ui.press("i", ..."Why?", "\r");
	ui.store.setState(101, session({ asks: [{ id: 1, question: "Why?", askedAt: Date.now(), status: "answering", answer: "" }] }));
	await new Promise((resolve) => setImmediate(resolve));
	ui.store.setState(101, session({ asks: [{ id: 1, question: "Why?", askedAt: Date.now(), status: "failed", answer: "", error: "prompt is too long" }] }));
	ui.app.onTick();
	assert.doesNotMatch(strip(ui.app.render(120).at(-1) ?? ""), /could not answer/);
	assert.match(ui.dialog() ?? "", /Why\?[\s\S]*✖ prompt is too long/);
});

test("a remote session's resume, new sessions and Git run on its host", async () => {
	const requests: [RelayOp, unknown][] = [];
	const answers: { [K in RelayOp]?: RelayOps[K]["result"] } = {
		sessions: [{ path: "/home/user/.pi/agent/sessions/p/a.jsonl", sessionId: "a", title: "earlier work", lastActive: Date.now() - 60_000 }],
		projects: [{ cwd: "/home/user/proj", lastActive: Date.now(), sessions: 1 }],
		launch: "pi-proj-1234abcd",
		git: cleanGitSummary({ cwd: "/home/user/proj", root: "/home/user/proj" }),
	};
	const remote = {
		name: "box03",
		status: { kind: "online", since: Date.now(), hostname: "eeprocsvr2" },
		request: async (op: RelayOp, params: unknown) => {
			requests.push([op, params]);
			return answers[op];
		},
	} as unknown as RemoteHost;
	const local = gitStub();
	const ui = harness("/nonexistent", undefined, local.service, new Map([["box03", remote]]));
	ui.store.setState(101, session({}));
	// The same pid on the remote host is its own row.
	ui.store.setState(101, session({ cwd: "/home/user/proj", lastSettledAt: Date.now() - 1000 }), "box03");
	ui.press("2");
	assert.match(strip(ui.app.render(120).join("\n")), /proj@box03/);

	ui.press("r");
	await eventually(() => assert.match(ui.dialog() ?? "", /Resume in box03:\/home\/user\/proj[\s\S]*earlier work/));
	ui.press("\r");
	await eventually(() => assert.match(strip(ui.app.render(120).at(-1) ?? ""), /started pi-proj-1234abcd .*box03:\/home\/user\/proj/));
	assert.deepEqual(requests.slice(0, 2), [
		["sessions", { cwd: "/home/user/proj" }],
		["launch", { cwd: "/home/user/proj", label: "proj", sessionFile: "/home/user/.pi/agent/sessions/p/a.jsonl" }],
	]);

	ui.press("n");
	assert.match(ui.dialog() ?? "", /this machine[\s\S]*box03 +online · eeprocsvr2/);
	ui.press("\x1b[B", "\r");
	await eventually(() => assert.match(ui.dialog() ?? "", /New session on box03 in/));
	assert.deepEqual(requests[2], ["projects", { live: ["/home/user/proj"] }], "the host's open projects only");
	ui.press(..."~/new", "\r");
	await eventually(() => assert.deepEqual(requests[3], ["launch", { cwd: "~/new", label: "new", sessionFile: undefined }]));

	ui.press("g");
	await eventually(() => assert.deepEqual(requests[4], ["git", { method: "getSummary", args: ["/home/user/proj"] }]));
	assert.deepEqual(local.calls, [], "nothing ran in this machine's repositories");
});
