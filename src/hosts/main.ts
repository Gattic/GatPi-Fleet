// pi-dash-host: installs pi-dash on remote hosts and lists them in hosts.json, so pi-dash shows
// and manages their pi sessions over ssh.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteHost, type HostStatus } from "../manager/remote/host.ts";
import { hostsPath, loadHosts, REMOTE_INSTALL_DIR, relayCommand, saveHosts, sshCommand, validHostName } from "../manager/remote/hosts.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
/** What a remote host runs: the bridge, the relay, and the screenrc for sessions it launches. */
const PAYLOAD = ["package.json", "bin", "config", "src"];
const PROBE_TIMEOUT_MS = 60_000;

const USAGE = `pi-dash-host — remote hosts whose pi sessions pi-dash shows and manages

add HOST...     Install or update pi-dash on each HOST (an ssh destination, e.g. a ~/.ssh/config
                alias) in ~/${REMOTE_INSTALL_DIR}, register its bridge with HOST's pi, check that
                the relay answers, and list HOST. Run it again after updating pi-dash here.
remove HOST...  Stop listing HOST (its install stays)
list            Listed hosts and whether their relay answers

Hosts are listed in ${hostsPath()}.
A host needs key-based ssh from here, GNU screen, pi, and Node.js >= 22.19 on its login PATH or
under ~/.nvm. pi sessions already running there connect after /reload.`;

/** The payload as git sees it (tracked or new, not ignored), so ignored local state such as `.pi/` stays here. */
function payloadFiles(): string[] {
	const listed = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...PAYLOAD], { encoding: "utf8" });
	// A tracked file deleted in the working tree is listed but has nothing to copy.
	return listed.split("\0").filter((file) => file && existsSync(join(ROOT, file)));
}

/** Starts the relay on `host` and waits for its greeting (or the reason there is none). */
async function probe(host: string): Promise<HostStatus> {
	const remote = new RemoteHost(host, { onState() {}, onBye() {}, onDisconnect() {}, onIncompatible() {}, onUsage() {}, onLost() {} });
	remote.start();
	const deadline = Date.now() + PROBE_TIMEOUT_MS;
	while (remote.status.kind === "connecting" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	const status = remote.status;
	remote.close();
	return status.kind === "connecting" ? { kind: "offline", since: Date.now(), error: "the relay did not answer within a minute" } : status;
}

/** Runs `command` (ssh and its arguments); its output goes to this terminal unless `capture`. */
function run(command: readonly string[], options: { input?: Buffer; capture?: boolean } = {}): string {
	const [program, ...args] = command;
	const output = execFileSync(program, args, { input: options.input, encoding: "utf8", stdio: [options.input ? "pipe" : "ignore", options.capture ? "pipe" : "inherit", "inherit"] });
	return output ?? "";
}

async function add(host: string): Promise<void> {
	const remoteName = run(sshCommand(host, ["hostname"]), { capture: true }).trim();
	// Its sessions are already shown as this machine's; a second install would load a second bridge.
	if (remoteName === hostname()) throw new Error(`${host} is this machine`);
	console.log(`${host} (${remoteName}): installing pi-dash in ~/${REMOTE_INSTALL_DIR}`);
	const archive = execFileSync("tar", ["-c", "-C", ROOT, "--null", "-T", "-"], { input: payloadFiles().join("\0"), maxBuffer: 256 * 1024 * 1024 });
	// Unpack beside the install and swap, so a failed transfer leaves the previous install intact.
	run(sshCommand(host, ["sh", "-c", `set -e; dir=${REMOTE_INSTALL_DIR}; rm -rf "$dir.new" "$dir.old"; mkdir -p "$dir.new"; tar -x -C "$dir.new"; if [ -e "$dir" ]; then mv "$dir" "$dir.old"; fi; mv "$dir.new" "$dir"; rm -rf "$dir.old"`]), { input: archive });
	console.log(`${host}: registering the bridge with pi`);
	run(relayCommand(host, ["install"]));
	const status = await probe(host);
	if (status.kind !== "online") throw new Error(`${host}: the relay does not answer: ${status.kind === "offline" ? status.error : status.kind}`);
	const hosts = loadHosts();
	if (!hosts.includes(host)) saveHosts([...hosts, host]);
	console.log(`${host}: ready. pi-dash shows its sessions; ones already running there connect after /reload.`);
}

async function main(): Promise<void> {
	const [action, ...names] = process.argv.slice(2);
	if (!action || action === "--help" || action === "-h") {
		console.log(USAGE);
		return;
	}
	for (const name of names) if (!validHostName(name)) throw new Error(`not an ssh host name: ${name}`);
	if (action === "add") {
		if (!names.length) throw new Error("add needs a HOST");
		for (const name of names) await add(name);
	} else if (action === "remove") {
		if (!names.length) throw new Error("remove needs a HOST");
		const hosts = loadHosts();
		for (const name of names) if (!hosts.includes(name)) throw new Error(`${name} is not listed`);
		saveHosts(hosts.filter((host) => !names.includes(host)));
	} else if (action === "list") {
		const hosts = loadHosts();
		if (!hosts.length) console.log(`No hosts listed in ${hostsPath()}. Add one with pi-dash-host add HOST.`);
		const statuses = await Promise.all(hosts.map(probe));
		hosts.forEach((host, index) => {
			const status = statuses[index];
			console.log(`${host.padEnd(16)} ${status.kind === "online" ? `online   ${status.hostname}` : `${status.kind.padEnd(8)} ${status.kind === "offline" ? status.error : ""}`}`);
		});
	} else {
		throw new Error(`unknown action ${action}; see pi-dash-host --help`);
	}
}

main().catch((error: unknown) => {
	console.error(`pi-dash-host: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
