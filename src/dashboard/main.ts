// pi-dash: one terminal to watch and drive every running pi session.
import { join } from "node:path";
import { getKeybindings, ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { GitCli } from "../manager/actions/git.ts";
import { hostsPath, loadHosts } from "../manager/remote/hosts.ts";
import { ManagerRuntime } from "../manager/runtime.ts";
import { HermesAdvisor } from "./hermes/advisor.ts";
import { App } from "./ui/app.ts";

function main(): void {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		process.stdout.write(`pi-dash — dashboard and manager for running pi sessions\n\nUsage: pi-dash\n\nInstall the bridge with pi install <repo>. Press ? for keys.\nRemote hosts: ${hostsPath()} (pi-dash-host add HOST)\nEnvironment: PI_CODING_AGENT_DIR, XDG_RUNTIME_DIR, XDG_CACHE_HOME, XDG_CONFIG_HOME\nMobile gateway: pi-dash-server --help\n`);
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write("pi-dash needs an interactive terminal\n");
		process.exit(1);
	}
	let hosts: string[];
	try {
		hosts = loadHosts();
	} catch (error) {
		process.stderr.write(`pi-dash: ${(error as Error).message}\n`);
		process.exit(1);
	}
	const runtime = new ManagerRuntime({ hosts });
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	getKeybindings().setUserBindings({ "tui.altScreen.pageUp": [], "tui.altScreen.pageDown": [] });
	const advisor = new HermesAdvisor({ ledgerPath: join(runtime.cacheDir, "hermes-advisor-events.jsonl") });
	let quitting = false;
	let spinner: NodeJS.Timeout;
	const quit = () => {
		if (quitting) return;
		quitting = true;
		clearInterval(spinner);
		tui.stop({ preserveScreen: true });
		void runtime.close().then(() => process.exit(0));
	};
	const app = new App({ tui, ...runtime, dismiss: (row) => runtime.dismiss(row), advisor, git: new GitCli(), quit });
	runtime.subscribe(() => {
		app.onTick();
		if (!app.isAttached) tui.requestRender();
	});
	tui.setLayoutRoot(app);
	tui.setFocus(app);
	process.on("SIGTERM", quit);
	process.on("SIGHUP", quit);
	process.on("uncaughtException", (error) => {
		tui.stop({ preserveScreen: true });
		process.stderr.write(`pi-dash crashed: ${error.stack ?? error.message}\n`);
		process.exit(1);
	});
	runtime.start();
	tui.start();
	spinner = setInterval(() => { if (app.advanceSpinner() && !app.isAttached) tui.requestRender(); }, 250);
}

main();
