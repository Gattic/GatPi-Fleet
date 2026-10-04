// pi-dash: one terminal to watch and drive every running pi session.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getKeybindings, ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { socketDir } from "../protocol/index.ts";
import { GitCli } from "./actions/git.ts";
import { BridgeHub } from "./collectors/bridges.ts";
import { GpuMonitor } from "./collectors/gpu.ts";
import { ProcSampler } from "./collectors/procs.ts";
import { QuotaMonitor } from "./collectors/quota.ts";
import { HermesAdvisor } from "./hermes/advisor.ts";
import { rowCwd, SAMPLE_MS, Store } from "./model/store.ts";
import { App } from "./ui/app.ts";
import { UsageIndex } from "./usage/usage-index.ts";

const USAGE_RETENTION_MS = 30 * 86_400_000;
const USAGE_SCAN_MS = 15_000;
const SLOW_POLL_MS = 5000;
const SPINNER_MS = 250;

const HELP = `pi-dash — dashboard and manager for running pi sessions

Usage: pi-dash

Shows every interactive pi process on this machine. Sessions need the pi-dash
bridge extension (pi install <pi-dash directory>) for live state and control;
others show resource usage only. Press ? inside for keys.

Environment:
  PI_CODING_AGENT_DIR   pi's agent directory (default ~/.pi/agent)
  XDG_RUNTIME_DIR       location of bridge sockets ($XDG_RUNTIME_DIR/pi-dash)
  XDG_CACHE_HOME        usage index cache (default ~/.cache/pi-dash)
`;

function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
}

function main(): void {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		process.stdout.write(HELP);
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write("pi-dash needs an interactive terminal\n");
		process.exit(1);
	}

	const agent = agentDir();
	const sessionRoot = join(agent, "sessions");
	const runtimeDir = socketDir();
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-dash");
	const cachePath = join(cacheDir, "usage-index.json");

	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	// Views always fit the terminal, so the viewport has nothing to page through; the detail view pages SAID instead.
	getKeybindings().setUserBindings({ "tui.altScreen.pageUp": [], "tui.altScreen.pageDown": [] });
	let app: App | undefined;
	const render = () => {
		if (app && !app.isAttached) tui.requestRender();
	};

	const store = new Store(render);
	const hub = new BridgeHub(runtimeDir, {
		onState: (pid, state) => store.setState(pid, state),
		onBye: (pid, reason) => store.bye(pid, reason),
		onDisconnect: (pid) => store.disconnect(pid),
		onIncompatible: (pid, version) => store.incompatible(pid, version),
	});
	const usage = new UsageIndex({ sessionRoot, cachePath, retentionMs: USAGE_RETENTION_MS, onUpdate: render });
	const quota = new QuotaMonitor(join(agent, "provider-failover-state.json"));
	const gpu = new GpuMonitor();
	const advisor = new HermesAdvisor({ ledgerPath: join(cacheDir, "hermes-advisor-events.jsonl") });
	const git = new GitCli();
	const sampler = new ProcSampler();

	const timers: NodeJS.Timeout[] = [];
	let quitting = false;
	const quit = () => {
		if (quitting) return;
		quitting = true;
		for (const timer of timers) clearInterval(timer);
		hub.close();
		void usage.close();
		tui.stop({ preserveScreen: true });
		process.exit(0);
	};

	app = new App({ tui, store, hub, usage, quota, gpu, advisor, git, sessionRoot, runtimeDir, quit });
	tui.setLayoutRoot(app);
	tui.setFocus(app);

	const subagentCwds = () => [...new Set([...usage.cwds(), ...store.ordered().flatMap((row) => rowCwd(row) ?? [])])];
	const sample = () => store.applySample(sampler.sample(store.targets(), gpu.latest), gpu.latest, Date.now());
	const slowPoll = () => {
		quota.poll();
		void gpu.poll();
	};

	process.on("SIGTERM", quit);
	process.on("SIGHUP", quit);
	process.on("uncaughtException", (error) => {
		tui.stop({ preserveScreen: true });
		process.stderr.write(`pi-dash crashed: ${error.stack ?? error.message}\n`);
		process.exit(1);
	});

	slowPoll();
	hub.scan();
	sample();
	usage.start();
	usage.scan(subagentCwds());
	tui.start();

	timers.push(
		setInterval(() => {
			hub.scan();
			store.tick(Date.now());
			app?.onTick();
			render();
		}, 1000),
		setInterval(sample, SAMPLE_MS),
		setInterval(slowPoll, SLOW_POLL_MS),
		setInterval(() => usage.scan(subagentCwds()), USAGE_SCAN_MS),
		setInterval(() => {
			if (app?.advanceSpinner()) render();
		}, SPINNER_MS),
	);
}

main();
