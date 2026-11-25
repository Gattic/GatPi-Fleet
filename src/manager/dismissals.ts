// Sessions the user dismissed, shared by this user's pi-dash processes on this host and reported by
// its relay to controllers elsewhere: the dashboard and the gateway keep separate stores, and a row
// dismissed in one must leave the others. One empty file per session incarnation (rowIncarnation
// without a host prefix) in the private runtime directory, including a run dismissed through its
// interrupted-session suggestion.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every running process reads a dismissal within seconds, and only a process that saw the session
 * running has its row; the week covers one that was suspended meanwhile.
 */
const RETENTION_MS = 7 * 86_400_000;

/** The file name for an incarnation. A host's dismissals name its own runs, without the host prefix. */
export function dismissalName(incarnation: string): string {
	return createHash("sha256").update(incarnation).digest("hex").slice(0, 32);
}

export class Dismissals {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	add(incarnation: string): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(this.dir, dismissalName(incarnation)), "");
		this.prune(Date.now());
	}

	/** The dismissed incarnations' file names, for a process that keeps another process's store. */
	names(): Set<string> {
		try {
			return new Set(readdirSync(this.dir));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
			throw error;
		}
	}

	private prune(now: number): void {
		for (const name of readdirSync(this.dir)) {
			const path = join(this.dir, name);
			try {
				if (now - statSync(path).mtimeMs > RETENTION_MS) unlinkSync(path);
			} catch (error) {
				// Another pi-dash process pruned it first.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}
