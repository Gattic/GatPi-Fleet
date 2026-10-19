// End-to-end: the real pi-dash TUI renews an expired Pi OAuth login and shuts down around that renewal.
// Offline and isolated: a temporary HOME/agent dir with synthetic credentials, an in-process stub for
// Anthropic's token/usage endpoints (test/fixtures/provider-stub.ts), and a network-less namespace.
//
// Positive controls (A-D) run the working tree. Negative controls (M0-M3) run mutants of it and must fail
// exactly the checks they target, so a check that cannot fail shows up as a failure of its control.
// Linux only. Needs tmux and unprivileged user+network namespaces (`unshare -r -n`, util-linux >= 2.23).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repo = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const stubUrl = new URL("../fixtures/provider-stub.ts", import.meta.url).href;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
// A user namespace (-r maps the caller to root inside it only, granting no privilege outside) lets an unprivileged
// user also create the network namespace that gives the TUI no network at all.
const namespace = ["-r", "-n"];
const subprocessTimeoutMs = 15_000;

interface StubEvent {
	t: number; main: boolean; kind: string;
	pid?: number; entry?: string; grant?: string; refresh?: string; authorization?: string | null; ok?: boolean;
	code?: number; persisted?: boolean; stack?: string[]; url?: string;
}
interface Login { type: "oauth"; access: string; refresh: string; expires: number }
interface Tree { path: string; kind: string }

const expired = (tag: string): Login => ({ type: "oauth", access: `SYN-ACCESS-EXPIRED-${tag}`, refresh: `SYN-REFRESH-${tag}`, expires: Date.now() - 60_000 });
const entryOf = (tree: Tree) => {
	const entry = join(tree.path, "src/dashboard/main.ts");
	return existsSync(entry) ? realpathSync(entry) : entry;
};

interface Check { id: string; name: string; ok: boolean; evidence: string }
class Checks {
	readonly all: Check[] = [];
	add(id: string, name: string, ok: boolean, evidence: unknown = ""): void {
		this.all.push({ id, name, ok, evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence) });
	}
	failedIds(): string[] { return this.all.filter((check) => !check.ok).map((check) => check.id).sort(); }
}

/** The TUI ran a different source tree than the one the test believes it is exercising. */
class WrongTree extends Error {}

let runCounter = 0;
/** Runs whose processes may still be alive; anything left here when this process ends is cleaned up synchronously. */
const liveRuns = new Set<Run>();
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class Run {
	readonly root = mkdtempSync(join(tmpdir(), "pidash-e2e-quota-"));
	readonly agent = join(this.root, "home", ".pi", "agent");
	readonly authPath = join(this.agent, "auth.json");
	readonly log = join(this.root, "events.jsonl");
	private readonly tree: Tree;
	private readonly checks: Checks;
	private readonly exitFile = join(this.root, "exit.code");
	private readonly socket = `pidash-e2e-${process.pid}-${++runCounter}`;
	private readonly tmuxEnv: NodeJS.ProcessEnv;
	private readonly script = join(this.root, "run.sh");

	constructor(options: { tree: Tree; auth: Record<string, Login>; failRefresh?: boolean; refreshDelayMs?: number }, checks: Checks) {
		liveRuns.add(this);
		this.tree = options.tree;
		this.checks = checks;
		const home = join(this.root, "home");
		mkdirSync(this.agent, { recursive: true });
		for (const dir of ["cache", "config", "data"]) mkdirSync(join(this.root, dir));
		for (const dir of ["run", "tmux"]) mkdirSync(join(this.root, dir), { mode: 0o700 });
		this.writeAuth(options.auth);
		writeFileSync(this.log, "");
		this.tmuxEnv = { PATH: process.env.PATH, HOME: home, TMUX_TMPDIR: join(this.root, "tmux"), LC_ALL: "C.UTF-8" };
		writeFileSync(this.script, `#!/bin/sh
export HOME=${quote(home)} PI_CODING_AGENT_DIR=${quote(this.agent)} XDG_RUNTIME_DIR=${quote(join(this.root, "run"))}
export XDG_CACHE_HOME=${quote(join(this.root, "cache"))} XDG_CONFIG_HOME=${quote(join(this.root, "config"))} XDG_DATA_HOME=${quote(join(this.root, "data"))}
export TERM=xterm-256color LC_ALL=C.UTF-8 NODE_OPTIONS=${quote(`--import ${stubUrl}`)}
export QUOTA_STUB_LOG=${quote(this.log)} QUOTA_STUB_TOKEN_MODE=${options.failRefresh ? "fail" : "ok"} QUOTA_STUB_TOKEN_DELAY_MS=${options.refreshDelayMs ?? 0}
cd ${quote(this.tree.path)}
unshare ${namespace.join(" ")} ${quote(process.execPath)} src/dashboard/main.ts
echo $? > ${quote(this.exitFile)}
`);
	}

	writeAuth(auth: Record<string, Login>): void {
		const temporary = `${this.authPath}.tmp`;
		writeFileSync(temporary, JSON.stringify(auth, null, 2), { mode: 0o600 });
		renameSync(temporary, this.authPath);
	}

	private tmux(...args: string[]) {
		return spawnSync("tmux", ["-u", "-L", this.socket, ...args], { env: this.tmuxEnv, encoding: "utf8", timeout: subprocessTimeoutMs });
	}

	/** Starts the TUI and proves that `expected` (default: the tree it was started from) is what executed. */
	async start(expected: Tree = this.tree): Promise<void> {
		const started = this.tmux("-f", "/dev/null", "new-session", "-d", "-s", "s", "-x", "120", "-y", "40", `sh ${quote(this.script)}`);
		assert.equal(started.status, 0, `tmux failed: ${started.stderr}`);
		const event = await this.wait(() => this.events("start").find((e) => e.main), 20_000, "TUI process start");
		const ran = realpathSync(event.entry!);
		const intended = ran === entryOf(expected);
		this.checks.add("tree-identity", `the TUI executed the intended tree (${expected.kind})`, intended, ran);
		if (!intended) throw new WrongTree(ran);
	}

	send(key: string): void { this.tmux("send-keys", "-t", "s", key); }
	screen(): string { return this.tmux("capture-pane", "-p", "-t", "s", "-S", "-").stdout; }

	events(kind?: string): StubEvent[] {
		const found: StubEvent[] = [];
		for (const line of readFileSync(this.log, "utf8").split("\n")) {
			try {
				const event = JSON.parse(line) as StubEvent;
				if (kind === undefined || event.kind === kind) found.push(event);
			} catch { /* blank line or a write still in flight */ }
		}
		return found;
	}

	auth(): Record<string, Login> { return JSON.parse(readFileSync(this.authPath, "utf8")); }
	authStamp(): { bytes: string; mtime: bigint } { return { bytes: readFileSync(this.authPath, "utf8"), mtime: statSync(this.authPath, { bigint: true }).mtimeNs }; }
	pid(): number | undefined { return this.events("start").find((e) => e.main)?.pid; }

	/** Only a process whose environment and command line identify this run is ever signalled. */
	private owned(pid: number): boolean {
		try {
			return readFileSync(`/proc/${pid}/environ`, "latin1").includes(this.root) && readFileSync(`/proc/${pid}/cmdline`, "latin1").includes("dashboard/main.ts");
		} catch { return false; }
	}

	alive(): boolean {
		const pid = this.pid();
		if (pid === undefined || !this.owned(pid)) return false;
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(")").pop()!.trim().split(" ")[0] !== "Z";
	}

	signal(name: NodeJS.Signals): void {
		const pid = this.pid();
		assert.ok(pid !== undefined && this.owned(pid), "refusing to signal a process that is not this run's TUI");
		process.kill(pid, name);
	}

	async wait<T>(find: () => T | undefined | false | null, timeoutMs: number, what: string): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = find();
			if (value) return value;
			await sleep(100);
		}
		throw new Error(`timed out waiting for ${what}`);
	}

	waitScreen(...patterns: RegExp[]): Promise<string> {
		return this.wait(() => { const text = this.screen(); return patterns.every((p) => p.test(text)) ? text : undefined; }, 30_000, `screen matching ${patterns.join(", ")}`);
	}

	async waitExit(timeoutMs: number): Promise<{ at: number; status: number }> {
		const exit = await this.wait(() => this.events("exit")[0], timeoutMs, "process exit");
		await this.wait(() => existsSync(this.exitFile), 5_000, "exit status file");
		return { at: exit.t, status: Number(readFileSync(this.exitFile, "utf8").trim()) };
	}

	diagnostics(): string {
		return `run kept at ${this.root}\nevents tail: ${JSON.stringify(this.events().slice(-8))}\nscreen:\n${this.screen().split("\n").slice(0, 25).join("\n")}`;
	}

	/** Every live process of this run (tmux server, wrapper shell, unshare, node): each has the unique run root in its environment. */
	private processes(): number[] {
		const found: number[] = [];
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
			try { if (readFileSync(`/proc/${name}/environ`, "latin1").includes(this.root)) found.push(Number(name)); } catch { /* exited, or not ours */ }
		}
		return found;
	}

	private killProcesses(): void {
		this.tmux("kill-server");
		for (const pid of this.processes()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
	}

	/** Deleting the directory only after every process is gone: the wrapper shell writes exit.code after node dies, and a TUI killed mid-start still creates files. */
	async teardown(keep: boolean): Promise<void> {
		this.killProcesses();
		await this.wait(() => this.processes().length === 0, 10_000, "the run's processes to exit");
		liveRuns.delete(this);
		if (!keep) rmSync(this.root, { recursive: true, force: true });
	}

	/** For when this process is itself going away (Ctrl-C, SIGTERM): the TUI never quits on its own, so nothing may outlive the test. */
	destroySync(): void {
		this.killProcesses();
		for (const deadline = Date.now() + 3_000; this.processes().length > 0 && Date.now() < deadline;) sleepSync(50);
		rmSync(this.root, { recursive: true, force: true });
	}
}

function destroyEverything(): void {
	for (const run of liveRuns) run.destroySync();
	liveRuns.clear();
	for (const { path } of mutants.values()) rmSync(path, { recursive: true, force: true });
}
process.once("exit", destroyEverything);
// `on`, not `once`: node's test runner can deliver SIGTERM twice, and once the one-shot listener is gone the second
// signal takes the default action and kills this process in the middle of the cleanup.
for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => process.exit(128 + osConstants.signals[name]));

type RunOptions = ConstructorParameters<typeof Run>[0];
interface Context { checks: Checks; open: (options: Omit<RunOptions, "tree">) => Run }
type Scenario = (context: Context) => Promise<void>;

/** Credential and provider-body material must not leak anywhere but auth.json (and the event log itself). */
function leakedFiles(run: Run): string[] {
	return readdirSync(run.root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name !== "auth.json" && entry.name !== "events.jsonl")
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((file) => readFileSync(file).includes("SYN-"))
		.map((file) => file.slice(run.root.length));
}

function commonChecks(checks: Checks, run: Run): void {
	const blocked = run.events("blocked");
	checks.add("nothing-blocked", "no request left the stub (nothing blocked)", blocked.length === 0, blocked);
	const leaked = leakedFiles(run);
	checks.add("no-token-leak", "no token appears in any file besides auth.json", leaked.length === 0, leaked);
	checks.add("lock-released", "auth.json lock released (no stale lock dir)", !existsSync(`${run.authPath}.lock`));
}

const scenarioA: Scenario = async ({ checks, open }) => {
	const alias = expired("ALIAS");
	const run = open({ auth: { anthropic: expired("OLD"), "anthropic-account-2": alias } });
	await run.start();
	const request = await run.wait(() => run.events("token-request")[0], 30_000, "token request");
	checks.add("refresh-with-stored-token", "TUI refreshed the expired login with its stored refresh token", request.grant === "refresh_token" && request.refresh === "SYN-REFRESH-OLD", request.grant);
	const probe = await run.wait(() => run.events("usage").find((e) => e.ok), 30_000, "usage probe with renewed token");
	checks.add("probe-with-renewed-token", "usage endpoint was probed with the renewed access token", probe.authorization === "Bearer SYN-ACCESS-NEW-1", probe.authorization);
	checks.add("expired-never-probed", "the expired token never reached the usage endpoint", !run.events("usage").some((e) => e.authorization?.includes("EXPIRED")));
	const auth = run.auth();
	checks.add("persisted-rotation", "auth.json holds the rotated access and refresh tokens", auth.anthropic.access === "SYN-ACCESS-NEW-1" && auth.anthropic.refresh === "SYN-REFRESH-NEW-1");
	const hoursLeft = (auth.anthropic.expires - Date.now()) / 3_600_000;
	checks.add("expiry-margin", "renewed expiry is ~8 h ahead (Pi's own 5-minute margin)", hoursLeft > 7 && hoursLeft < 8, hoursLeft.toFixed(2));
	const mode = statSync(run.authPath).mode & 0o777;
	checks.add("mode-0600", "auth.json keeps mode 0600", mode === 0o600, mode.toString(8));
	checks.add("alias-untouched", "alias login (not known to Pi's plain runtime) untouched, no refresh attempted for it",
		isDeepStrictEqual(auth["anthropic-account-2"], alias) && !run.events("token-request").some((e) => e.refresh === "SYN-REFRESH-ALIAS"));
	// A wait that times out throws and fails the scenario, so these need no always-true check of their own.
	await run.waitScreen(/anthropic\s+5h.*63% left/, /anthropic\s+7d.*39% left/, /anthropic#2.*OAuth refresh required in Pi/);
	await sleep(12_000);
	const counts = `tokens=${run.events("token-request").length} usage=${run.events("usage").length}`;
	checks.add("no-repeat", "no further refresh or probe over the next 12 s (two poll ticks)", counts === "tokens=1 usage=1", counts);
	run.send("u");
	await run.waitScreen(/COST BY SESSION/, /anthropic\s+5h.*63% left/); // the usage view renders the renewed quota
	run.send("Escape");
	// Esc immediately followed by q reaches the TUI as the single key Alt+q, so wait for the overview first.
	await run.wait(() => !run.screen().includes("COST BY SESSION"), 10_000, "overview after Esc");
	run.send("q");
	const exit = await run.waitExit(10_000);
	checks.add("quit-clean", "quit (q) exits cleanly", exit.status === 0, `exit status ${exit.status}`);
	commonChecks(checks, run);
};

const shutdownMidRenewal = (via: "key" | "term"): Scenario => async ({ checks, open }) => {
	// The provider answers 8 s after the request; the "still pending" check at 2 s keeps a 6 s margin on a slow machine.
	const run = open({ auth: { anthropic: expired("OLD") }, refreshDelayMs: 8_000 });
	await run.start();
	await run.wait(() => run.events("token-request")[0], 30_000, "token request");
	const stopped = Date.now();
	if (via === "key") run.send("q"); else run.signal("SIGTERM");
	await sleep(2_000);
	checks.add("alive-and-pending", "still alive 2 s after the stop request: no process.exit requested, provider response still pending",
		run.alive() && run.events("exit-called").length === 0 && run.events("exit").length === 0 && run.events("token-response").length === 0);
	const exit = await run.waitExit(25_000);
	const response = run.events("token-response")[0];
	const called = run.events("exit-called")[0];
	// An exit that merely follows the response (the event loop drained after the stub's timer) is not a shutdown that waited.
	checks.add("exit-after-response", "pi-dash called process.exit(0), and only after the provider response",
		Boolean(response && called && called.code === 0 && called.t >= response.t),
		response && called ? `${called.t - response.t >= 0 ? "+" : ""}${called.t - response.t} ms vs response` : `response=${Boolean(response)} process.exit called=${Boolean(called)}`);
	checks.add("persisted-before-exit", "the rotated credentials were already in auth.json when process.exit was requested", Boolean(called?.persisted));
	const auth = run.auth();
	checks.add("final-credentials", "auth.json holds the rotated credentials after exit", auth.anthropic.access === "SYN-ACCESS-NEW-1" && auth.anthropic.refresh === "SYN-REFRESH-NEW-1");
	const waitedSeconds = (exit.at - stopped) / 1000;
	checks.add("waited", "shutdown waited for the renewal (stop -> exit >= 3 s)", waitedSeconds >= 3, `${waitedSeconds.toFixed(1)} s`);
	checks.add("exit-status", "clean exit status 0", exit.status === 0, `exit status ${exit.status}`);
	checks.add("no-usage-after-stop", "no usage probe was started after shutdown began", run.events("usage").length === 0);
	commonChecks(checks, run);
};

const scenarioD: Scenario = async ({ checks, open }) => {
	const run = open({ auth: { anthropic: expired("OLD") }, failRefresh: true });
	const before = run.authStamp();
	await run.start();
	await run.wait(() => run.events("token-request")[0], 30_000, "token request");
	await run.waitScreen(/anthropic.*OAuth refresh required in Pi/);
	await sleep(16_000);
	checks.add("one-attempt", "exactly one refresh attempt in 16+ s (spacing, no retry storm)", run.events("token-request").length === 1, run.events("token-request").length);
	checks.add("no-usage-while-unusable", "no usage probe while the login is unusable", run.events("usage").length === 0);
	checks.add("no-error-leak", "provider error body / tokens are never displayed", !/SYN-|invalid_grant|refresh_token/.test(run.screen()), "screen + scrollback scanned");
	checks.add("auth-untouched", "auth.json untouched by the failed renewal", isDeepStrictEqual(run.authStamp(), before));
	run.writeAuth({ anthropic: { type: "oauth", access: "SYN-ACCESS-LOGIN", refresh: "SYN-REFRESH-LOGIN", expires: Date.now() + 8 * 3_600_000 } });
	const probe = await run.wait(() => run.events("usage").find((e) => e.ok), 30_000, "usage probe after re-login");
	checks.add("relogin-probed", "a fresh Pi login is detected and probed with its own token", probe.authorization === "Bearer SYN-ACCESS-LOGIN", probe.authorization);
	checks.add("relogin-no-extra-refresh", "the fresh login needed no further refresh attempt", run.events("token-request").length === 1, run.events("token-request").length);
	await run.waitScreen(/anthropic\s+5h.*63% left/); // throws, failing the scenario, unless the quota bars come back
	run.send("q");
	const exit = await run.waitExit(10_000);
	checks.add("quit-clean", "quit exits cleanly", exit.status === 0, `exit status ${exit.status}`);
	commonChecks(checks, run);
};

/** Recreates the original false pass: the TUI runs one tree while the test believes it is another. */
const scenarioWrongTree: Scenario = async ({ open }) => {
	const run = open({ auth: { anthropic: expired("OLD") } });
	await run.start({ path: "/nonexistent/mutant", kind: "mislabelled mutant" }); // must refuse before any behavioural check
};

const SCENARIOS = {
	A: { title: "renewal: expired login is renewed through Pi, then probed with the renewed token", run: scenarioA },
	B: { title: "shutdown mid-renewal via the q key", run: shutdownMidRenewal("key") },
	C: { title: "shutdown mid-renewal via SIGTERM", run: shutdownMidRenewal("term") },
	D: { title: "failed renewal: sanitized diagnostic, no retry storm, no write, recovery on a new login", run: scenarioD },
} as const;

interface Control { id: string; description: string; edits: [file: string, from: string, to: string][]; expect: Partial<Record<keyof typeof SCENARIOS, readonly string[]>> }
const QUOTA = "src/manager/collectors/quota.ts";
const AWAIT_RENEWAL = "await Promise.all([...[...this.logins.values()].map((login) => login.pending), ...this.renewing.values()]);";
const IMMEDIATE_LOSS = ["alive-and-pending", "exit-after-response", "persisted-before-exit", "final-credentials", "waited"];
const HUNG_CLOSE = ["exit-after-response", "persisted-before-exit"];
const CONTROLS: Control[] = [
	{ id: "M1", description: "close() ignores an in-flight renewal: the process exits before Pi persists the rotated token",
		edits: [[QUOTA, AWAIT_RENEWAL, "await Promise.all([...this.logins.values()].map((login) => login.pending));"]],
		expect: { B: IMMEDIATE_LOSS, C: IMMEDIATE_LOSS } },
	{ id: "M2", description: "close() never settles: the process only drains once the provider response arrives",
		edits: [[QUOTA, AWAIT_RENEWAL, "await new Promise<void>(() => {}); // never settles"]],
		expect: { B: HUNG_CLOSE, C: HUNG_CLOSE } },
	{ id: "M3", description: "no spacing between renewal attempts: a failing login is retried on every poll tick",
		edits: [[QUOTA, "this.renewAt.set(provider, now + RENEW_RETRY_MS);", "// no spacing"]],
		expect: { D: ["one-attempt", "relogin-no-extra-refresh"] } },
];

const mutants = new Map<string, Tree>();
/** A copy of the working tree's sources with one deliberate defect; each edit must match exactly once. */
function mutantTree(control: Control): Tree {
	const existing = mutants.get(control.id);
	if (existing) return existing;
	const path = mkdtempSync(join(tmpdir(), "pidash-e2e-mutant-"));
	try {
		cpSync(join(repo, "src"), join(path, "src"), { recursive: true });
		copyFileSync(join(repo, "package.json"), join(path, "package.json"));
		symlinkSync(join(repo, "node_modules"), join(path, "node_modules")); // Node does not strip types inside node_modules, so only dependencies live there
		for (const [file, from, to] of control.edits) {
			const source = readFileSync(join(path, file), "utf8");
			assert.equal(source.split(from).length - 1, 1, `${control.id}: mutation target must occur exactly once in ${file}; update the control to match the code`);
			writeFileSync(join(path, file), source.replace(from, () => to));
		}
	} catch (error) {
		rmSync(path, { recursive: true, force: true }); // never leave an unmutated copy for the control's next test to run as if it were the mutant
		throw error;
	}
	const tree = { path, kind: `${control.id} mutant of the working tree` };
	mutants.set(control.id, tree);
	return tree;
}

/** Runs one scenario and requires exactly `expectedFailures` to fail; keeps the run directory when that is not so. */
async function execute(t: TestContext, tree: Tree, scenario: Scenario, expectedFailures: readonly string[] = []): Promise<void> {
	const checks = new Checks();
	const runs: Run[] = [];
	let error: unknown;
	try {
		await scenario({ checks, open: (options) => { const run = new Run({ ...options, tree }, checks); runs.push(run); return run; } });
	} catch (caught) {
		if (!(caught instanceof WrongTree)) error = caught; // already recorded as a failed tree-identity check
	}
	const failed = checks.failedIds();
	const expected = [...expectedFailures].sort();
	const unexpected = failed.filter((id) => !expected.includes(id));
	const missed = expected.filter((id) => !failed.includes(id));
	const matched = error === undefined && unexpected.length === 0 && missed.length === 0;
	if (!matched) for (const run of runs) t.diagnostic(run.diagnostics());
	let teardownError: unknown;
	for (const run of runs) {
		try { await run.teardown(!matched); } catch (caught) { teardownError ??= caught; }
	}
	if (matched && teardownError === undefined) return;
	const detail = (ids: string[]) => ids.map((id) => `  ${id}: ${checks.all.filter((check) => check.id === id).map((check) => `${check.name} [${check.evidence}]`).join("; ")}`).join("\n");
	assert.fail([
		error === undefined ? undefined : `scenario aborted: ${error instanceof Error ? error.message : String(error)}`,
		teardownError === undefined ? undefined : `teardown failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`,
		unexpected.length ? `checks that failed but should have passed:\n${detail(unexpected)}` : undefined,
		missed.length ? `checks that passed but the control must trip (a check that cannot fail):\n${detail(missed)}` : undefined,
	].filter(Boolean).join("\n"));
}

const workingTree: Tree = { path: repo, kind: "working tree" };
const timeout = 180_000;

describe("quota renewal through the real pi-dash TUI (offline, synthetic credentials)", { concurrency: Math.min(4, availableParallelism()) }, () => {
	before(() => {
		assert.equal(process.platform, "linux", "the isolated TUI run needs Linux namespaces");
		assert.equal(spawnSync("tmux", ["-V"], { timeout: subprocessTimeoutMs }).status, 0, "tmux must be on PATH");
		const probe = spawnSync("unshare", [...namespace, "true"], { encoding: "utf8", timeout: subprocessTimeoutMs });
		assert.equal(probe.status, 0, `unprivileged user and network namespaces are required (\`unshare ${namespace.join(" ")}\` failed: ${probe.stderr.trim() || probe.error?.message})`);
	});
	after(() => { for (const { path } of mutants.values()) rmSync(path, { recursive: true, force: true }); });

	test("guard: a network-less namespace blocks a real fetch", () => {
		const probe = "fetch('https://api.anthropic.com/').then(() => process.exit(0), (error) => { console.log(error.cause?.code ?? error.message); process.exit(3); })";
		const result = spawnSync("unshare", [...namespace, process.execPath, "-e", probe], { encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 3, `a real request must fail inside the namespace, got: ${result.stdout}${result.stderr}`);
	});

	for (const [letter, { title, run }] of Object.entries(SCENARIOS)) {
		test(`positive ${letter}. ${title}`, { timeout }, (t) => execute(t, workingTree, run));
	}

	test("negative M0. the harness refuses a tree it did not intend to test", { timeout }, (t) => execute(t, workingTree, scenarioWrongTree, ["tree-identity"]));

	for (const control of CONTROLS) {
		for (const [letter, ids] of Object.entries(control.expect) as [keyof typeof SCENARIOS, readonly string[]][]) {
			test(`negative ${control.id}/${letter}. ${control.description}`, { timeout }, (t) => execute(t, mutantTree(control), SCENARIOS[letter].run, ids));
		}
	}
});
