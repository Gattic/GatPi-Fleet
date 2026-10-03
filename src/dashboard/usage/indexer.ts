// Incremental usage index over pi session files: reads only bytes appended
// since the last scan and keeps hourly buckets for a bounded retention window.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FileMeta, scanBuffer, type UsageRecord } from "./extract.ts";
import type { FileUsage, ScanRequest } from "./types.ts";

const CACHE_VERSION = 1;
const CHUNK_BYTES = 8 * 1024 * 1024;
const HOUR_MS = 3_600_000;

interface Candidate {
	path: string;
	kind: FileUsage["kind"];
	parentSessionId?: string;
}

function listJsonl(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

function listDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

/** A rewritten file (e.g. pi migrating an old session format) no longer has a line break at our offset. */
function endsLineAt(path: string, offset: number): boolean {
	if (offset === 0) return true;
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const byte = Buffer.alloc(1);
		return readSync(fd, byte, 0, 1, offset - 1) === 1 && byte[0] === 0x0a;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** GatPi-Harness records which session spawned each subagent. */
function subagentParent(cwd: string, subagentId: string): string | undefined {
	try {
		const record = JSON.parse(readFileSync(join(cwd, ".pi", "subagents", "records", `${subagentId}.json`), "utf8")) as { parentSessionId?: string };
		return record.parentSessionId ?? undefined;
	} catch {
		return undefined;
	}
}

export class UsageIndexer {
	readonly files = new Map<string, FileUsage>();
	private readonly cachePath: string | undefined;
	private readonly parents = new Map<string, string | undefined>();

	constructor(cachePath?: string) {
		this.cachePath = cachePath;
	}

	load(): FileUsage[] {
		if (!this.cachePath) return [];
		try {
			const cache = JSON.parse(readFileSync(this.cachePath, "utf8")) as { version: number; files: FileUsage[] };
			if (cache.version !== CACHE_VERSION) return [];
			for (const file of cache.files) this.files.set(file.path, file);
		} catch {}
		return [...this.files.values()];
	}

	save(): void {
		if (!this.cachePath) return;
		mkdirSync(dirname(this.cachePath), { recursive: true, mode: 0o700 });
		const temp = `${this.cachePath}.${process.pid}.tmp`;
		writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, files: [...this.files.values()] }), { mode: 0o600 });
		renameSync(temp, this.cachePath);
	}

	scan(request: ScanRequest, now = Date.now()): { changed: FileUsage[]; removed: string[] } {
		const cutoff = now - request.retentionMs;
		const cutoffHour = Math.floor(cutoff / HOUR_MS);
		const candidates: Candidate[] = [];
		for (const dir of listDirs(request.sessionRoot)) {
			for (const path of listJsonl(dir)) candidates.push({ path, kind: "session" });
		}
		for (const cwd of request.subagentCwds) {
			for (const dir of listDirs(join(cwd, ".pi", "subagents", "rpc-sessions"))) {
				const id = dir.slice(dir.lastIndexOf("/") + 1);
				if (!this.parents.has(dir)) this.parents.set(dir, subagentParent(cwd, id));
				for (const path of listJsonl(dir)) candidates.push({ path, kind: "subagent", parentSessionId: this.parents.get(dir) });
			}
		}

		const changed: FileUsage[] = [];
		const seen = new Set<string>();
		for (const candidate of candidates) {
			let size: number;
			let mtimeMs: number;
			try {
				({ size, mtimeMs } = statSync(candidate.path));
			} catch {
				continue;
			}
			if (mtimeMs < cutoff) continue;
			seen.add(candidate.path);
			let entry = this.files.get(candidate.path);
			if (entry && entry.size === size && entry.mtimeMs === mtimeMs) continue;
			if (!entry || size < entry.offset || !endsLineAt(candidate.path, entry.offset)) {
				entry = { path: candidate.path, kind: candidate.kind, size: 0, mtimeMs: 0, offset: 0, hours: {} };
				this.files.set(candidate.path, entry);
			}
			entry.parentSessionId = candidate.parentSessionId ?? entry.parentSessionId;
			this.indexFile(entry, size, cutoff);
			entry.size = size;
			entry.mtimeMs = mtimeMs;
			changed.push(entry);
		}

		const removed: string[] = [];
		for (const [path, entry] of this.files) {
			if (!seen.has(path)) {
				this.files.delete(path);
				removed.push(path);
				continue;
			}
			let pruned = false;
			for (const hour of Object.keys(entry.hours)) {
				if (Number(hour) < cutoffHour) {
					delete entry.hours[hour];
					pruned = true;
				}
			}
			if (pruned && !changed.includes(entry)) changed.push(entry);
		}
		return { changed, removed };
	}

	private indexFile(entry: FileUsage, size: number, cutoff: number): void {
		const meta: FileMeta = { sessionId: entry.sessionId, cwd: entry.cwd, name: entry.name, firstPrompt: entry.firstPrompt };
		const records: UsageRecord[] = [];
		let fd: number;
		try {
			fd = openSync(entry.path, "r");
		} catch {
			return;
		}
		try {
			const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
			let position = entry.offset;
			let carry = Buffer.alloc(0);
			while (position < size) {
				const read = readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
				if (read <= 0) break;
				position += read;
				const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
				const consumed = scanBuffer(data, meta, records);
				carry = Buffer.from(data.subarray(consumed));
				for (const usage of records) {
					if (usage.ts < cutoff) continue;
					const hour = String(Math.floor(usage.ts / HOUR_MS));
					const models = (entry.hours[hour] ??= {});
					const bucket = (models[usage.model] ??= { tokens: 0, cost: 0, cacheRead: 0, prompt: 0 });
					bucket.tokens += usage.tokens;
					bucket.cost += usage.cost;
					bucket.cacheRead += usage.cacheRead;
					bucket.prompt += usage.prompt;
				}
				records.length = 0;
			}
			entry.offset = position - carry.length;
		} finally {
			closeSync(fd);
		}
		entry.sessionId = meta.sessionId;
		entry.cwd = meta.cwd;
		entry.name = meta.name;
		entry.firstPrompt = meta.firstPrompt;
	}
}
