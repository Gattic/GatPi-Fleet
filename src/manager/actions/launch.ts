// All manager-created sessions use the same cross-process launch reservation.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { socketDir } from "../../protocol/index.ts";
import { rowCwd, type SessionRow } from "../model/store.ts";
import { processIdentity, sessionFileKey } from "../recovery.ts";
import { screenConfig } from "./screen-config.ts";

interface ScreenSession {
	pid: number;
	alive: boolean;
}

/** Screen servers by session name; a server killed without cleanup leaves a "(Remote or dead)" socket. */
export function screenSessions(): Map<string, ScreenSession> {
	let output: string;
	try { output = execFileSync("screen", ["-ls"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
	catch (error) { output = String((error as { stdout?: string }).stdout ?? ""); }
	const sessions = new Map<string, ScreenSession>();
	for (const match of output.matchAll(/^\s+(\d+)\.(\S+)\s+\(([^)]*)\)/gm)) {
		sessions.set(match[2], { pid: Number(match[1]), alive: !/dead/i.test(match[3]) });
	}
	return sessions;
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

export function launchReservation(file: string, runtimeDir: string): string {
	return join(runtimeDir, "launches", `${createHash("sha256").update(realpathSync(file)).digest("hex")}.json`);
}

interface ProcessWitness {
	pid: number;
	/** Recorded only when /proc can prove it; without one, the process can never be proven gone. */
	identity?: string;
}

/** A claim on one saved conversation: the screen that runs it, and the processes that can still be launching it. */
interface LaunchClaim {
	screen: string;
	at: number;
	/** The pi-dash process that created the claim: a launch can be in flight only while it lives. */
	controller?: ProcessWitness;
	/** The screen server that took the claim over, recorded once the session exists. */
	owner?: ProcessWitness;
}

function witness(pid: number): ProcessWitness {
	const identity = processIdentity(pid);
	return typeof identity === "string" ? { pid, identity } : { pid };
}

/** An unavailable identity is unknown, not proof of death; a different one is a reused PID. */
function gone(entry: ProcessWitness): boolean {
	if (entry.identity === undefined) return false;
	const current = processIdentity(entry.pid);
	return current !== null && current !== entry.identity;
}

function readClaim(path: string): LaunchClaim | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object") return undefined;
		const claim = value as LaunchClaim;
		return typeof claim.screen === "string" && claim.screen !== "" && Number.isFinite(claim.at) ? claim : undefined;
	} catch {
		// An unreadable claim stays reserved: only evidence, never a parse error, releases it.
		return undefined;
	}
}

/** Age is no proof: an absent screen can still be a launch in flight. Only a recorded owner proven gone is. */
function staleClaim(claim: LaunchClaim, screens: Map<string, ScreenSession>): boolean {
	const screen = screens.get(claim.screen);
	if (screen) return !screen.alive;
	// The claim precedes its screen, so before the owner is recorded only the controller can prove it idle.
	if (claim.owner) return gone(claim.owner);
	return claim.controller ? gone(claim.controller) : false;
}

function writeClaim(path: string, claim: LaunchClaim): void {
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(claim), { mode: 0o600 });
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * Moves the judged claim aside. Renaming is atomic, so simultaneous reclaimers cannot both take it;
 * the moved file then proves which claim was taken, so one replaced after judging is restored untouched.
 */
function reclaim(path: string, judged: LaunchClaim): boolean {
	const moved = `${path}.${process.pid}.${randomUUID()}.stale`;
	try { renameSync(path, moved); }
	catch (error) {
		// Another controller moved it first; the next create reports the winner's claim.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	const taken = readClaim(moved);
	if (taken && taken.screen === judged.screen && taken.at === judged.at) {
		rmSync(moved, { force: true });
		return true;
	}
	// A launch in flight replaced the claim after it was judged: put it back rather than delete it.
	try { linkSync(moved, path); }
	catch { /* another claim took the name first; the moved one no longer owns anything */ }
	rmSync(moved, { force: true });
	return false;
}

/** Takes the reservation, reclaiming only a claim whose recorded owner is provably gone. */
function claimReservation(path: string, screen: string): void {
	const claim: LaunchClaim = { screen, at: Date.now(), controller: witness(process.pid) };
	for (;;) {
		let fd: number;
		try { fd = openSync(path, "wx", 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = readClaim(path);
			if (existing && staleClaim(existing, screenSessions()) && reclaim(path, existing)) continue;
			throw new Error(`Session launch is reserved. Inspect ${path} on the host before removing a stale reservation`);
		}
		try { writeFileSync(fd, JSON.stringify(claim)); }
		catch (error) { rmSync(path, { force: true }); throw error; }
		finally { closeSync(fd); }
		return;
	}
}

/** Best effort: the session already runs, so an unrecorded owner only keeps the next launch conservative. */
function recordOwner(path: string, screen: string): void {
	const claim = readClaim(path);
	const found = claim ? screenSessions().get(screen) : undefined;
	if (!claim || !found?.alive) return;
	try { writeClaim(path, { ...claim, owner: witness(found.pid) }); }
	catch { /* The conservative claim still blocks a second writer. */ }
}

/** Reservation remains until its screen exits, including if this controller dies. */
export function launchSession(options: LaunchOptions, rows: readonly SessionRow[], runtimeDir = socketDir()): string {
	const cwd = realpathSync(options.cwd);
	const file = options.sessionFile ? realpathSync(options.sessionFile) : undefined;
	if (file) {
		const reason = resumeBlocked(rows, cwd, file);
		if (reason) throw new Error(reason);
	}
	const { path: screenrc, env } = screenConfig();
	const slug = options.label.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 24) || "session";
	const name = `pi-${slug}-${randomUUID().slice(0, 8)}`;
	let reservation: string | undefined;
	if (file) {
		const dir = join(runtimeDir, "launches");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		reservation = launchReservation(file, runtimeDir);
		claimReservation(reservation, name);
	}
	delete env.TMUX;
	delete env.TMUX_PANE;
	try {
		execFileSync("screen", ["-c", screenrc, "-dmS", name, "-t", options.label, "sh", "-c", 'cleanup="$2"; trap \'if [ -n "$cleanup" ]; then rm -f -- "$cleanup"; fi\' EXIT; cd -- "$1" || exit; shift 2; pi "$@"', "pi-dash", cwd, reservation ?? "", ...(file ? ["--session", file] : [])], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
	} catch (error) {
		if (reservation) rmSync(reservation, { force: true });
		// screen says why it did not start (on stdout, e.g. about /run/screen); the failed command line does not.
		// One line: the dashboard shows it in its one-line footer.
		const { stdout, stderr } = error as { stdout?: string | null; stderr?: string | null };
		const reason = `${stdout ?? ""} ${stderr ?? ""}`.replace(/\s+/g, " ").trim();
		throw reason ? new Error(`screen could not start pi: ${reason}`) : error;
	}
	// The session now owns the claim. A killed screen leaves this record behind, so the next launch
	// can prove the claim stale instead of asking the operator to remove a file nothing owns.
	if (reservation) recordOwner(reservation, name);
	return name;
}
