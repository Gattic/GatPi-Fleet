// Bridge-owned lifecycle records survive both pi and its controllers. Only identity metadata is
// persisted, never prompts or transcripts. A missing shutdown is evidence of interruption, not OOM.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionState } from "../protocol/index.ts";

export function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? configured.replace(/^~(?=\/)/, homedir()) : join(homedir(), ".pi", "agent");
}

/** Pi can open a saved conversation through a symlink; ownership belongs to the actual file. */
export function sessionFileKey(file: string): string {
	try { return realpathSync(file); }
	catch (error) {
		// A new session may not have saved its first message yet, or the user removed its file.
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return resolve(file);
		throw error;
	}
}

export interface RecoveryRecord {
	version: 1;
	pid: number;
	instanceId: string;
	/** Linux boot ID plus /proc start ticks: a reused PID is not the original process. */
	processIdentity: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	name?: string;
	startedAt: number;
}

export interface InterruptedSession extends RecoveryRecord { host?: string }

type IdentityReader = (pid: number) => string | undefined | null;

/** undefined means gone; null means unknown (permissions etc.), which must not suggest recovery. */
export function processIdentity(pid: number): string | undefined | null {
	try {
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[0] === "Z" || fields[0] === "X") return undefined;
		return /^\d+$/.test(fields[19]) ? `${boot}:${fields[19]}` : null;
	} catch (error) {
		return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "") ? undefined : null;
	}
}

function isRecord(value: unknown): value is RecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const row = value as RecoveryRecord;
	return row.version === 1 && Number.isSafeInteger(row.pid) && row.pid > 0 &&
		["instanceId", "processIdentity", "sessionId", "sessionFile", "cwd"].every((key) => typeof (row as unknown as Record<string, unknown>)[key] === "string" && Boolean((row as unknown as Record<string, unknown>)[key])) &&
		Number.isFinite(row.startedAt) && (row.name === undefined || typeof row.name === "string");
}

export class RecoveryJournal {
	readonly dir: string;
	private readonly identity: IdentityReader;

	constructor(agent = agentDir(), identity: IdentityReader = processIdentity) {
		this.dir = join(agent, "pi-dash", "recovery");
		this.identity = identity;
	}

	private path(instanceId: string): string {
		return join(this.dir, `${createHash("sha256").update(instanceId).digest("hex")}.json`);
	}

	private alive(record: RecoveryRecord): boolean {
		const current = this.identity(record.pid);
		return current === null || current === record.processIdentity;
	}

	private records(): RecoveryRecord[] {
		let names: string[];
		try { names = readdirSync(this.dir); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return names.filter((name) => name.endsWith(".json")).flatMap((name) => {
			try {
				const record: unknown = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
				return isRecord(record) && this.path(record.instanceId) === join(this.dir, name) ? [{ ...record, sessionFile: sessionFileKey(record.sessionFile) }] : [];
			} catch (error) {
				// A concurrent shutdown removes records. A malformed record is not crash evidence.
				if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		});
	}

	/** Called synchronously at session_start and when its file/name becomes known. */
	track(state: Pick<SessionState, "pid" | "instanceId" | "sessionId" | "sessionFile" | "cwd" | "name">, startedAt = Date.now()): void {
		if (!state.sessionFile) return; // --no-session cannot be recovered.
		const identity = this.identity(state.pid);
		if (!identity) throw new Error("Cannot record pi recovery: process identity unavailable");
		const record: RecoveryRecord = { version: 1, pid: state.pid, instanceId: state.instanceId, sessionId: state.sessionId, sessionFile: sessionFileKey(state.sessionFile), cwd: state.cwd, name: state.name, processIdentity: identity, startedAt };
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const path = this.path(record.instanceId);
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
		renameSync(temp, path);
		// A real new bridge, not a successful screen command, proves a resume took place.
		// A replacement extension supersedes the old instance in its process, including reload.
		// Wall clocks can go backwards; current process ownership, not timestamp order, is decisive.
		for (const previous of this.records()) {
			if (previous.instanceId === record.instanceId) continue;
			const replaced = previous.pid === record.pid && previous.processIdentity === identity;
			if (replaced || (previous.sessionFile === record.sessionFile && !this.alive(previous))) this.remove(previous.instanceId);
		}
	}

	private remove(instanceId: string): void {
		try { unlinkSync(this.path(instanceId)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}

	/** An intentional close settles this run and dead overlapping owners, never another live run. */
	close(instanceId: string): void {
		const records = this.records();
		const current = records.find((record) => record.instanceId === instanceId);
		if (!current) return; // Late cleanup from an already replaced bridge has no authority.
		for (const record of records) {
			if (record.instanceId === instanceId || (record.sessionFile === current.sessionFile && !this.alive(record))) this.remove(record.instanceId);
		}
	}

	list(): RecoveryRecord[] {
		const records = this.records();
		const live = new Set(records.filter((record) => this.alive(record)).map((record) => record.sessionFile));
		const latest = new Map<string, RecoveryRecord>();
		for (const record of records) {
			if (live.has(record.sessionFile)) continue;
			if ((latest.get(record.sessionFile)?.startedAt ?? -Infinity) < record.startedAt) latest.set(record.sessionFile, record);
		}
		return [...latest.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Revalidate at action time; stale dialogs cannot dismiss or resume a now-live session. */
	interrupted(instanceId: string): RecoveryRecord {
		const record = this.list().find((entry) => entry.instanceId === instanceId);
		if (!record) throw new Error("Session recovery changed; refresh the interrupted sessions list");
		return record;
	}

	dismiss(instanceId: string): void {
		// Shared controllers may dismiss twice, or the bridge may have closed gracefully meanwhile.
		if (!this.records().some((record) => record.instanceId === instanceId)) return;
		const record = this.interrupted(instanceId);
		for (const previous of this.records()) {
			if (previous.sessionFile === record.sessionFile && !this.alive(previous)) this.remove(previous.instanceId);
		}
	}
}
