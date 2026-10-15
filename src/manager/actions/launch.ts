// All manager-created sessions use the same cross-process launch reservation.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { socketDir } from "../../protocol/index.ts";
import { rowCwd, type SessionRow } from "../model/store.ts";
import { sessionFileKey } from "../recovery.ts";

const SCREENRC = fileURLToPath(new URL("../../../config/screenrc", import.meta.url));

export function screenNames(): Set<string> {
	let output: string;
	try { output = execFileSync("screen", ["-ls"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
	catch (error) { output = String((error as { stdout?: string }).stdout ?? ""); }
	return new Set([...output.matchAll(/^\s+\d+\.(\S+)\s/gm)].map((match) => match[1]));
}

export function resumeBlocked(rows: readonly SessionRow[], cwd: string, file: string): string | undefined {
	// Remote paths belong to that host, not this controller's filesystem. Its relay uses local
	// rows and performs the canonical check; controller-side remote checks are lexical only.
	const localKey = rows.some((row) => row.host === undefined) ? sessionFileKey(file) : undefined;
	for (const row of rows) {
		if (row.exitedAt !== undefined) continue;
		const openFile = row.bridge?.sessionFile;
		if (openFile && (row.host === undefined ? sessionFileKey(openFile) === localKey : openFile === file)) return "That session is already open; select its running session instead";
		if (rowCwd(row) === cwd && (!row.bridge || !row.connected)) return "A process in this project has no current bridge; its session file ownership is unknown. Reload or close it locally before resuming";
	}
	return undefined;
}

export interface LaunchOptions { cwd: string; label: string; sessionFile?: string }

/** Reservation remains until its screen exits, including if this controller dies. */
export function launchSession(options: LaunchOptions, rows: readonly SessionRow[], runtimeDir = socketDir()): string {
	const cwd = realpathSync(options.cwd);
	const file = options.sessionFile ? realpathSync(options.sessionFile) : undefined;
	if (file) {
		const reason = resumeBlocked(rows, cwd, file);
		if (reason) throw new Error(reason);
	}
	const slug = options.label.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 24) || "session";
	const name = `pi-${slug}-${randomUUID().slice(0, 8)}`;
	let reservation: string | undefined;
	if (file) {
		const dir = join(runtimeDir, "launches");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		reservation = join(dir, `${createHash("sha256").update(file).digest("hex")}.json`);
		// Do not reclaim by age: two controllers can race while replacing a stale file.
		// Normal exit removes it; after an abnormal exit the operator reconciles locally.
		let fd: number;
		try { fd = openSync(reservation, "wx", 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Session launch is reserved. Inspect ${reservation} on the host before removing a stale reservation`);
			throw error;
		}
		try { writeFileSync(fd, JSON.stringify({ screen: name, at: Date.now() })); }
		catch (error) { rmSync(reservation, { force: true }); throw error; }
		finally { closeSync(fd); }
	}
	const env = { ...process.env };
	delete env.TMUX;
	delete env.TMUX_PANE;
	try {
		execFileSync("screen", ["-c", SCREENRC, "-dmS", name, "-t", options.label, "sh", "-c", 'cleanup="$2"; trap \'if [ -n "$cleanup" ]; then rm -f -- "$cleanup"; fi\' EXIT; cd -- "$1" || exit; shift 2; pi "$@"', "pi-dash", cwd, reservation ?? "", ...(file ? ["--session", file] : [])], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
	} catch (error) {
		if (reservation) rmSync(reservation, { force: true });
		// screen says why it did not start (on stdout, e.g. about /run/screen); the failed command line does not.
		// One line: the dashboard shows it in its one-line footer.
		const { stdout, stderr } = error as { stdout?: string | null; stderr?: string | null };
		const reason = `${stdout ?? ""} ${stderr ?? ""}`.replace(/\s+/g, " ").trim();
		throw reason ? new Error(`screen could not start pi: ${reason}`) : error;
	}
	return name;
}
