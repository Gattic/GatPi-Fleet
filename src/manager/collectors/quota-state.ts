// Shared Anthropic polling state. Only normalized readings, deadlines and a one-way
// credential fingerprint are persisted; Pi's auth and failover state remain untouched.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuotaReading } from "./quota.ts";

interface PollState {
	credentialKey: string;
	reservation: string;
	/** Completed-poll schedule plus any observed server backoff, independent of the lease. */
	nextAt: number;
	pendingUntil?: number;
	reading?: QuotaReading;
}

function valid(value: unknown): value is PollState {
	if (!value || typeof value !== "object") return false;
	const state = value as PollState;
	if (!/^[a-f0-9]{64}$/.test(state.credentialKey) || typeof state.reservation !== "string" || !state.reservation || !Number.isSafeInteger(state.nextAt) || state.nextAt < 0) return false;
	if (state.pendingUntil !== undefined && (!Number.isSafeInteger(state.pendingUntil) || state.pendingUntil < 0)) return false;
	const r = state.reading;
	return r === undefined || (r !== null && typeof r === "object" &&
		(r.fetchedAt === null || (Number.isSafeInteger(r.fetchedAt) && r.fetchedAt >= 0)) &&
		(r.error === undefined || (typeof r.error === "string" && r.error.length <= 160 && !/[\x00-\x1f\x7f]/.test(r.error))) &&
		Array.isArray(r.windows) && r.windows.length <= 2 && r.windows.every((w) => w &&
			typeof w.label === "string" && /^\d+(m|h|d)$/.test(w.label) &&
			typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 &&
			(w.resetAt === null || (Number.isSafeInteger(w.resetAt) && w.resetAt > 0))));
}

export class SharedUsageState {
	readonly dir: string;
	constructor(authFile: string) { this.dir = join(dirname(authFile), "pi-dash", "quota"); }

	private path(provider: string): string {
		if (!/^anthropic(?:-account-\d+)?$/.test(provider)) throw new Error("Unsupported shared quota provider");
		return join(this.dir, `${provider}.json`);
	}

	read(provider: string): PollState | undefined {
		const file = this.path(provider);
		try {
			if (statSync(file).size > 64 * 1024) throw new Error("Shared usage state too large");
			const state: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!valid(state)) throw new Error("Invalid shared usage state");
			return state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	private write(provider: string, state: PollState): void {
		const file = this.path(provider);
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
			renameSync(temp, file);
		} finally { rmSync(temp, { force: true }); }
	}

	private locked<T>(provider: string, change: () => T): T {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const fd = openSync(`${this.path(provider)}.lock`, "a", 0o600);
		try {
			// Linux flock locks the shared open-file description: the parent's fd keeps
			// this lock after the helper exits. Closing it (including process death)
			// releases the lock, so no stale-lock deletion or PID heuristics are needed.
			const lock = spawnSync("flock", ["-w", "1", "3"], { stdio: ["ignore", "ignore", "pipe", fd], timeout: 2000 });
			if (lock.error || lock.status !== 0) throw new Error("Shared usage lock unavailable");
			return change();
		} finally { closeSync(fd); }
	}

	claim(provider: string, credentialKey: string, now: number, interval: number): { claimed: boolean; state: PollState } {
		return this.locked(provider, () => {
			const previous = this.read(provider);
			if (previous && now < Math.max(previous.nextAt, previous.pendingUntil ?? 0)) return { claimed: false, state: previous };
			const state: PollState = { credentialKey, reservation: randomUUID(), nextAt: previous?.nextAt ?? 0, pendingUntil: now + interval,
				reading: previous?.credentialKey === credentialKey ? previous.reading : undefined };
			this.write(provider, state);
			return { claimed: true, state };
		});
	}

	/** Server backoff belongs to the provider, even if the requesting owner is obsolete or closed. */
	backoff(provider: string, retryAt: number): void {
		this.locked(provider, () => {
			const state = this.read(provider);
			if (!state) throw new Error("Shared usage reservation missing");
			if (retryAt > state.nextAt) this.write(provider, { ...state, nextAt: retryAt });
		});
	}

	complete(provider: string, reservation: string, nextAt: number, reading: QuotaReading): boolean {
		return this.locked(provider, () => {
			const state = this.read(provider);
			if (!state) throw new Error("Shared usage reservation missing");
			// A paused process can outlive its reservation. Only its backoff, not its
			// stale reading, may affect the current account state.
			if (state.reservation !== reservation) return false;
			this.write(provider, { ...state, nextAt: Math.max(state.nextAt, nextAt), pendingUntil: undefined, reading });
			return true;
		});
	}

	/** Only a request rejected before transport may release its lease without a poll delay. */
	cancel(provider: string, reservation: string): void {
		this.locked(provider, () => {
			const state = this.read(provider);
			if (!state) throw new Error("Shared usage reservation missing");
			if (state.reservation !== reservation) return;
			this.write(provider, { ...state, pendingUntil: undefined });
		});
	}
}
