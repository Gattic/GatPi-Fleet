import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { sessionDirName } from "../src/dashboard/actions/sessions.ts";
import type { BridgeHub } from "../src/dashboard/collectors/bridges.ts";
import { GpuMonitor } from "../src/dashboard/collectors/gpu.ts";
import { QuotaMonitor } from "../src/dashboard/collectors/quota.ts";
import { Store } from "../src/dashboard/model/store.ts";
import { App } from "../src/dashboard/ui/app.ts";
import { UsageIndex } from "../src/dashboard/usage/usage-index.ts";
import { type Command, emptyUsage, type SessionState } from "../src/protocol/index.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** App with a terminal-free TUI stand-in: keys go to the top overlay, like pi-tui's overlay focus. */
function harness(sessionRoot: string) {
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
	const hub = { isConnected: () => true, send: async (_pid: number, command: Command) => void sent.push(command) } as unknown as BridgeHub;
	const store = new Store(() => {});
	let quits = 0;
	const app = new App({
		tui,
		store,
		hub,
		usage: new UsageIndex({ sessionRoot, cachePath: "", retentionMs: 0, onUpdate: () => {} }),
		quota: new QuotaMonitor("/nonexistent"),
		gpu: new GpuMonitor(),
		sessionRoot,
		runtimeDir: "/nonexistent",
		quit: () => quits++,
	});
	return {
		app,
		store,
		sent,
		quits: () => quits,
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

test("quit asks first while a close-and-restart is waiting for its session to exit", () => {
	const ui = harness("/nonexistent");
	const now = Date.now();
	ui.store.setState(101, { pid: 101, cwd: "/home/user/dev/proj", sessionId: "s", phase: "working", phaseSince: now, lastEventAt: now, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [] });

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

test("quit without pending work does not ask", () => {
	const ui = harness("/nonexistent");
	ui.press("q");
	assert.equal(ui.dialog(), undefined);
	assert.equal(ui.quits(), 1);
});

test("resume asks first when a live session in the project has no bridge", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-app-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "proj");
	mkdirSync(cwd);
	const sessionDir = join(root, "sessions", sessionDirName(cwd));
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: new Date().toISOString(), cwd })}\n`);
	// An unconfirmed resume would try to launch screen; keep it off PATH so the test never starts pi.
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
	assert.match(ui.dialog() ?? "", /slot 1 in this project has no bridge.*Resume anyway\?/s);
	ui.press("n");
	assert.equal(ui.dialog(), undefined);
	assert.doesNotMatch(strip(ui.app.render(120).at(-1) ?? ""), /started|launch failed/);
});

function session(overrides: Partial<SessionState>): SessionState {
	const now = Date.now();
	return { pid: 101, cwd: "/home/user/dev/proj", sessionId: "s", phase: "idle", phaseSince: now, lastEventAt: now, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], ...overrides };
}

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
