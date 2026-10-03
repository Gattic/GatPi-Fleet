// GNU screen integration: launch pi in a detached screen, multi-display
// attach, and read-only peeks via hardcopy.
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCREENRC = fileURLToPath(new URL("../../../config/screenrc", import.meta.url));

function slug(text: string): string {
	return text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "session";
}

/** Names of existing screen sessions (the part after `<pid>.`). */
export function screenNames(): Set<string> {
	let output: string;
	try {
		output = execFileSync("screen", ["-ls"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch (error) {
		// `screen -ls` exits non-zero whenever it lists sessions.
		output = String((error as { stdout?: string }).stdout ?? "");
	}
	const names = new Set<string>();
	for (const match of output.matchAll(/^\s+\d+\.(\S+)\s/gm)) names.add(match[1]);
	return names;
}

export interface LaunchOptions {
	cwd: string;
	label: string;
	/** Resume this session file instead of starting a new session. */
	sessionFile?: string;
}

/** Start pi in a new detached screen; when pi exits the screen ends. Returns the screen name. */
export function launchSession(options: LaunchOptions): string {
	const existing = screenNames();
	const base = `pi-${slug(options.label)}`;
	let name = base;
	for (let suffix = 2; existing.has(name); suffix++) name = `${base}-${suffix}`;
	const piArgs = options.sessionFile ? ["--session", options.sessionFile] : [];
	const env = { ...process.env };
	// pi runs inside screen, not in the terminal multiplexer the dashboard may run in.
	delete env.TMUX;
	delete env.TMUX_PANE;
	execFileSync(
		"screen",
		["-c", SCREENRC, "-dmS", name, "-t", options.label, "sh", "-c", 'cd -- "$1" && shift && exec pi "$@"', "pi-dash", options.cwd, ...piArgs],
		{ stdio: "ignore", env },
	);
	return name;
}

/**
 * Multi-display attach (`screen -rx`): the session stays visible in its
 * original terminal too. Resolves when the user detaches (Ctrl-a d).
 */
export function attachSession(sty: string, window: string | undefined): Promise<void> {
	const env = { ...process.env };
	// Attaching from inside another screen would otherwise trigger screen's nesting guard.
	delete env.STY;
	const args = ["-rx", sty, ...(window !== undefined ? ["-p", window] : [])];
	return new Promise((resolve) => {
		const child = spawn("screen", args, { stdio: "inherit", env });
		child.on("exit", () => resolve());
		child.on("error", () => resolve());
	});
}

/** Ask screen to dump the window's current text into `file` (written asynchronously by screen). */
export function requestHardcopy(sty: string, window: string | undefined, file: string): void {
	execFile("screen", ["-S", sty, ...(window !== undefined ? ["-p", window] : []), "-X", "hardcopy", file], () => {});
}

export function readHardcopy(file: string): string[] | undefined {
	try {
		const lines = readFileSync(file, "utf8").split("\n");
		while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
		return lines;
	} catch {
		return undefined;
	}
}
