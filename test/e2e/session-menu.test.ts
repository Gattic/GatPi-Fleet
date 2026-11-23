// End-to-end: the session menu (m) of the real pi-dash TUI drives a real interactive pi.
// pi runs the way users run it: plain `pi` in a detached GNU screen, with the bridge and a local scripted
// model loaded from its settings, so the pi that a restart launches is reachable too. The TUI runs in a
// private tmux. The test presses keys and reads the screen, and watches the same bridge through its own
// BridgeHub to see what pi really did.
// Isolated and offline: a temporary HOME, agent, runtime, config and Screen directory. Needs tmux and screen.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { screenConfig } from "../../src/manager/actions/screen-config.ts";
import { BridgeHub, pidAlive } from "../../src/manager/collectors/bridges.ts";
import type { SessionState } from "../../src/protocol/index.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-dash-e2e-menu-"));
// The project's name is the session's label; pi sessions of this machine that the TUI also lists never share it.
const label = `menu-e2e-${process.pid}`;
const project = join(root, label);
const agent = join(root, "home", ".pi", "agent");
const sockets = join(root, "run", "pi-dash");
const exitFile = join(root, "exit.code");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const env: NodeJS.ProcessEnv = {
	PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: agent,
	XDG_RUNTIME_DIR: join(root, "run"), XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
	SCREENDIR: join(root, "screens"), TERM: "xterm-256color", LC_ALL: "C.UTF-8",
	PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
};
const tmuxEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: env.HOME, TMUX_TMPDIR: join(root, "tmux"), LC_ALL: "C.UTF-8" };
const tmuxSocket = `pi-dash-e2e-menu-${process.pid}`;

const states = new Map<number, SessionState>();
const byes: string[] = [];
const hub = new BridgeHub(sockets, {
	onState: (pid, state) => states.set(pid, state),
	onBye: (_pid, reason) => byes.push(reason),
	onDisconnect: () => {},
	onIncompatible: () => {},
});
/** The pi process the test follows; a restart replaces it. */
let pid = 0;
const session = () => states.get(pid) as SessionState;

function tmux(...args: string[]) {
	return spawnSync("tmux", ["-u", "-L", tmuxSocket, ...args], { env: tmuxEnv, encoding: "utf8", timeout: 15_000 });
}

/** One key at a time: keys sent together can reach the TUI as a single chunk (Esc then q is Alt+q). */
const press = (key: string) => void tmux("send-keys", "-t", "s", key);
const screen = () => tmux("capture-pane", "-p", "-t", "s").stdout;
const footer = () => screen().split("\n").filter((line) => line.trim()).at(-1) ?? "";

/** The text inside the dialog's frame as one line (messages wrap), without the dimmed view around it. */
function dialog(): string | undefined {
	const lines = screen().split("\n");
	const top = lines.findIndex((line) => line.includes("╭─"));
	const bottom = lines.findIndex((line) => line.includes("╰─"));
	if (top < 0 || bottom < top) return undefined;
	return lines.slice(top, bottom + 1).map((line) => /[╭│╰](.*)[╮│╯]/.exec(line)?.[1] ?? "").join(" ").replace(/\s+/g, " ");
}

async function waitFor<T>(what: string, check: () => T | undefined | false | null, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		hub.scan();
		const value = check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting for ${what}; the TUI shows:\n${screen()}`);
}

const matches = (text: string | undefined, patterns: RegExp[]) => text !== undefined && patterns.every((pattern) => pattern.test(text)) && text;
const dialogShows = (what: string, ...patterns: RegExp[]) => waitFor(what, () => matches(dialog(), patterns));
const footerShows = (pattern: RegExp) => waitFor(`the footer to say ${pattern}`, () => matches(footer(), [pattern]));
const dialogCloses = () => waitFor("the dialog to close", () => dialog() === undefined);

/** Selects the session's live row by its slot, whatever other sessions the overview lists. */
async function select(): Promise<string> {
	const slot = await waitFor("the session's live row with a slot in the overview", () => new RegExp(`^[▌ ]([1-9]) ${label} +[○◆]`, "m").exec(screen())?.[1]);
	press(slot);
	await waitFor("the session to be selected", () => new RegExp(`^▌${slot} ${label} `, "m").test(screen()));
	return slot;
}

/**
 * Runs a turn and waits until the TUI shows its reply on the idle session. The TUI finds a bridge that was
 * replaced (reload, new conversation) on its next scan; only the session's current incarnation has this reply.
 */
async function turn(prompt: string): Promise<void> {
	const reply = `echo: ${prompt}`;
	await hub.send(session(), { kind: "prompt", text: prompt });
	await waitFor(`the reply to "${prompt}"`, () => session().phase === "idle" && session().lastSaid === reply);
	const idle = new RegExp(`^▌[1-9] ${label} +◆ needs you`, "m");
	await waitFor(`the TUI to show the reply to "${prompt}"`, () => {
		const shown = screen();
		return shown.includes(reply) && idle.test(shown);
	});
}

async function openMenu(...state: RegExp[]): Promise<string> {
	assert.equal(dialog(), undefined, "m is pressed in the view, not in a dialog");
	press("m");
	return dialogShows("the session menu", new RegExp(`Session · ${label}`), ...state);
}

function screens(): string[] {
	let output: string;
	try { output = execFileSync("screen", ["-ls"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
	catch (error) { output = String((error as { stdout?: string }).stdout ?? ""); }
	return [...output.matchAll(/^\s+(\d+\.\S+)\s/gm)].map((match) => match[1]);
}

let cleaned = false;
/** The TUI never quits on its own and pi outlives its launcher, so nothing of this run may be left behind. */
function cleanup(): void {
	if (cleaned) return;
	cleaned = true;
	hub.close();
	tmux("kill-server");
	for (const name of screens()) {
		try { execFileSync("screen", ["-S", name, "-X", "quit"], { env, stdio: "ignore" }); } catch {}
	}
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.once("exit", cleanup);
for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => process.exit(128 + osConstants.signals[name]));

before(async () => {
	assert.equal(spawnSync("tmux", ["-V"]).status, 0, "tmux must be on PATH");
	mkdirSync(agent, { recursive: true });
	mkdirSync(project);
	for (const dir of ["cache", "config", "data"]) mkdirSync(join(root, dir));
	for (const dir of ["run", "screens", "tmux"]) mkdirSync(join(root, dir), { mode: 0o700 });
	writeFileSync(join(agent, "settings.json"), JSON.stringify({
		extensions: [join(repo, "src/bridge/index.ts"), join(repo, "test/fixtures/scripted-provider.ts")],
		defaultProvider: "dash-test",
		defaultModel: "scripted",
	}));
	const { path: screenrc, env: screenEnv } = screenConfig(env);
	execFileSync("screen", ["-c", screenrc, "-dmS", `pi-${label}`, "sh", "-c", 'cd "$1" && exec pi', "e2e", project], { env: screenEnv });
	pid = await waitFor("the bridge of the real pi", () => [...states.keys()][0], 30_000);

	const script = join(root, "run.sh");
	const exports = Object.entries(env).map(([name, value]) => `export ${name}=${quote(value as string)}`).join("\n");
	writeFileSync(script, `#!/bin/sh\n${exports}\ncd ${quote(repo)}\n${quote(process.execPath)} src/dashboard/main.ts\necho $? > ${quote(exitFile)}\n`);
	const started = tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "-x", "140", "-y", "45", `sh ${quote(script)}`);
	assert.equal(started.status, 0, `tmux failed: ${started.stderr}`);
});

after(cleanup);

test("m lists the real session's commands under its live state, and says why a command cannot run now", async () => {
	assert.equal(session().model, "dash-test/scripted");
	await select();
	const menu = await openMenu(/○ ready · dash-test\/scripted/);
	for (const command of [/x +abort/, /s +said/, /Z +compact/, /M +model/, /T +thinking/, /R +rename/, /a +attach/, /L +reload/, /N +new conversation/, /S +restart/, /c +close/, /C +recycle/, /r +resume/, /d +dismiss/]) assert.match(menu, command);

	await hub.send(session(), { kind: "prompt", text: "sleep 4" });
	await dialogShows("the open menu to follow the run", /⚙ bash \d+s · dash-test\/scripted/);
	press("S");
	await footerShows(new RegExp(`${label} must be idle to restart`));
	assert.equal(dialog(), undefined, "the refused command closed the menu without a confirmation");
	await waitFor("the run to settle", () => session().phase === "idle" && session().lastSaid === "slept 4");
	assert.ok(pidAlive(pid), "pi keeps running");
});

test("L in the menu reloads the real pi: same process and conversation, a new bridge incarnation", async () => {
	const before = session();
	await openMenu(/◆ needs you/);
	press("L");
	await dialogShows("the reload confirmation", /Reload session/, new RegExp(`Reload ${label}\\?`), /without closing or clearing/);
	assert.equal(session().instanceId, before.instanceId, "nothing is sent before the answer");
	press("y");
	await footerShows(new RegExp(`reloading ${label}`));
	await waitFor("the reloaded bridge", () => session().instanceId !== before.instanceId && hub.isConnected(pid));
	assert.ok(byes.includes("reload"));
	assert.equal(session().sessionId, before.sessionId);
	assert.equal(session().sessionFile, before.sessionFile);
	assert.equal(session().lastSaid, "slept 4", "the conversation is kept");
	assert.ok(pidAlive(pid), "pi was not closed");
	assert.equal(dialog(), undefined);
});

test("a menu left open across a reload refuses to act on the incarnation that replaced its session", async () => {
	await turn("after reload");
	const before = session();
	await openMenu(/◆ needs you/);
	await hub.send(before, { kind: "reload" });
	await waitFor("the replacing incarnation", () => session().instanceId !== before.instanceId && hub.isConnected(pid));
	await dialogShows("the menu to notice the replacement", /session ended or was replaced; select its current instance/);
	press("c");
	await footerShows(new RegExp(`${label} ended or was replaced; select its current instance`));
	assert.equal(dialog(), undefined, "no close confirmation for the replacement");
	await new Promise((resolve) => setTimeout(resolve, 1000));
	hub.scan();
	assert.ok(pidAlive(pid) && hub.isConnected(pid), "the replacement keeps running");
	assert.ok(!byes.includes("quit"));
});

test("N in the menu starts a new conversation in the same pi, like /new", async () => {
	const before = session();
	await openMenu(/◆ needs you/);
	press("N");
	await dialogShows("the new conversation confirmation", /New conversation/, new RegExp(`Start a new conversation in ${label}\\?`), /Like pi's \/new/);
	press("y");
	await footerShows(new RegExp(`starting a new conversation in ${label}`));
	await waitFor("the new conversation", () => session().sessionId !== before.sessionId && hub.isConnected(pid));
	assert.equal(session().pid, before.pid);
	assert.equal(session().cwd, before.cwd);
	assert.deepEqual(session().prompts, []);
	assert.equal(session().lastSaid, undefined, "the context is cleared");
	assert.ok(existsSync(before.sessionFile as string), "the old conversation stays saved");
});

test("S in the menu restarts the real pi: a new process in the same slot resumes the saved conversation", { timeout: 90_000 }, async () => {
	await turn("keep this");
	const before = session();
	assert.ok(existsSync(before.sessionFile as string), "the conversation is saved");
	const slot = await select();
	await openMenu(/◆ needs you/);
	press("S");
	await dialogShows("the restart confirmation", /Restart session/, new RegExp(`Restart ${label}\\?`), /resume this same saved/);
	assert.ok(pidAlive(before.pid), "nothing happens before the answer");
	press("y");
	await footerShows(new RegExp(`restarting ${label}; select its new instance when it appears`));
	const next = await waitFor("the replacement pi", () => [...states.values()].find((state) => state.pid !== before.pid && state.sessionId === before.sessionId), 60_000);
	assert.ok(byes.includes("quit"), "the old pi closed gracefully");
	await waitFor("the old pi to exit", () => !pidAlive(before.pid));
	pid = next.pid;
	assert.equal(next.sessionFile, before.sessionFile);
	assert.equal(next.cwd, before.cwd);
	assert.equal(next.lastSaid, "echo: keep this", "the conversation is resumed");
	assert.equal(await select(), slot, "the new instance takes the slot of the one it replaces");
	await openMenu(/◆ needs you \d+s · dash-test\/scripted/);
	press("Escape");
	await dialogCloses();
});

test("c in the menu closes the real pi, and q leaves the dashboard", async () => {
	await openMenu();
	press("c");
	await dialogShows("the close confirmation", new RegExp(`Close ${label}\\?`));
	press("y");
	await waitFor("pi to exit", () => !pidAlive(pid));
	await waitFor("the row to show the exit", () => new RegExp(`${label} +◌ exited`).test(screen()));
	press("q");
	await waitFor("pi-dash to exit", () => existsSync(exitFile));
	assert.equal(readFileSync(exitFile, "utf8").trim(), "0");
});
