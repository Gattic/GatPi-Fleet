// Exited sessions the user dismissed, shared by this user's pi-dash processes: the dashboard and the
// gateway keep separate stores, and a row dismissed in one must leave the other. One empty file per
// session incarnation (rowIncarnation) in the private runtime directory.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every running process reads a dismissal within seconds, and only a process that saw the session
 * running has its row; the week covers one that was suspended meanwhile.
 */
const RETENTION_MS = 7 * 86_400_000;

function entryName(incarnation: string): string {
	return createHash("sha256").update(incarnation).digest("hex").slice(0, 32);
}

export class Dismissals {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	add(incarnation: string): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(this.dir, entryName(incarnation)), "");
		this.prune(Date.now());
	}

	/** Which of `incarnations` were dismissed, by this process or another. */
	dismissed(incarnations: readonly string[]): Set<string> {
		let names: Set<string>;
		try {
			names = new Set(readdirSync(this.dir));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
			throw error;
		}
		return new Set(incarnations.filter((incarnation) => names.has(entryName(incarnation))));
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
