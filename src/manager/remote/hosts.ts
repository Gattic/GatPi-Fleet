// Remote hosts: the list in hosts.json (ssh destinations, usually ~/.ssh/config aliases) and the
// ssh commands that reach them.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where pi-dash-host installs pi-dash on a remote host, relative to its home (ssh's working directory). */
export const REMOTE_INSTALL_DIR = ".local/share/pi-dash";

export function hostsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-dash", "hosts.json");
}

/** An ssh destination that cannot be mistaken for an option, and is safe in row keys and file names. */
export function validHostName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/.test(name);
}

/** `{"hosts": ["box00", "boxhome"]}`; no file means no remote hosts. */
export function loadHosts(path: string = hostsPath()): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const value = JSON.parse(text) as { hosts?: unknown };
	const hosts = value?.hosts;
	if (!Array.isArray(hosts) || !hosts.every((host): host is string => typeof host === "string" && validHostName(host))) {
		throw new Error(`${path}: expected {"hosts": ["ssh-host", ...]} with ssh host names`);
	}
	if (new Set(hosts).size !== hosts.length) throw new Error(`${path}: a host is listed twice`);
	return hosts;
}

export function saveHosts(hosts: readonly string[], path: string = hostsPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ hosts }, null, 2)}\n`);
	renameSync(temp, path);
}

/** One word for the remote shell, which ssh hands the command line to. */
export function shellQuote(word: string): string {
	return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const SSH_OPTIONS = ["-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"];

/** ssh running `command` on `host` without a terminal and without prompting (pi-dash cannot answer). */
export function sshCommand(host: string, command: readonly string[]): string[] {
	return ["ssh", "-T", "-o", "BatchMode=yes", ...SSH_OPTIONS, host, ...command.map(shellQuote)];
}

/** ssh running `command` on `host` in this terminal. */
export function sshTerminalCommand(host: string, command: readonly string[]): string[] {
	return ["ssh", "-t", ...SSH_OPTIONS, host, ...command.map(shellQuote)];
}

export function relayCommand(host: string, args: readonly string[] = []): string[] {
	return sshCommand(host, [`${REMOTE_INSTALL_DIR}/bin/pi-dash-relay`, ...args]);
}
