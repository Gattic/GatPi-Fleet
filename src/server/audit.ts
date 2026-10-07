// Metadata only. Ten one-megabyte segments maximum, seven-day age limit.
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class Audit {
	private file = "";
	private bytes = 0;
	private day = "";
	readonly dir: string;
	constructor(dir: string) { this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 }); this.prune(); }
	private prune(): void {
		const files = readdirSync(this.dir).filter((f) => /^audit-[\d-]+-[a-f0-9-]+\.jsonl$/.test(f)).map((f) => ({ path: join(this.dir, f), at: statSync(join(this.dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
		for (const [i, f] of files.entries()) if (i >= 10 || Date.now() - f.at > 7 * 86_400_000) unlinkSync(f.path);
	}
	write(device: string, target: string, action: string, outcome: string): void {
		const day = new Date().toISOString().slice(0, 10);
		const line = JSON.stringify({ at: Date.now(), device, target, action, outcome }) + "\n";
		if (!this.file || this.bytes + Buffer.byteLength(line) > 1_000_000 || day !== this.day) {
			this.file = join(this.dir, `audit-${day}-${randomUUID()}.jsonl`); this.bytes = 0; this.day = day;
		}
		appendFileSync(this.file, line, { mode: 0o600 });
		this.bytes += Buffer.byteLength(line);
		this.prune();
	}
}
