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
	ui.store.setState(101, { pid: 101, cwd: "/home/user/dev/proj", sessionId: "s", phase: "working", phaseSince: now, lastEventAt: now, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [] });

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
	ui.store.applySample({ resources: new Map(), piProcesses: [{ pid: 202, cwd }], host: { cpu: 0, cores: 1, memUsed: 0, memTotal: 1, load1: 0 } }, undefined, Date.now());

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
	return { pid: 101, cwd: "/home/user/dev/proj", sessionId: "s", phase: "idle", phaseSince: now, lastEventAt: now, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], ...overrides };
}

test("the composer offers the suggested next prompt while idle; Tab takes it", () => {
	const ui = harness("/nonexistent");
	ui.store.setState(101, session({ suggestion: "Run the tests\nand report" }));
	ui.press("p");
	assert.match(ui.dialog() ?? "", /↳ Run the tests\s+│\n│ {3}and report/);
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
