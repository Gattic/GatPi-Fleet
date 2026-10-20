// Main-thread view of the usage index maintained by the index worker.
import { Worker } from "node:worker_threads";
import type { FileUsage, IndexUpdate, ScanRequest, UsageBucket, UsageDelta } from "./types.ts";

const HOUR_MS = 3_600_000;
export const USAGE_RETENTION_MS = 30 * 86_400_000;

export function emptyBucket(): UsageBucket {
	return { tokens: 0, cost: 0, cacheRead: 0, prompt: 0 };
}

function addBucket(target: UsageBucket, source: UsageBucket): void {
	target.tokens += source.tokens;
	target.cost += source.cost;
	target.cacheRead += source.cacheRead;
	target.prompt += source.prompt;
}

/** A file's key in the index. Remote hosts' paths and session ids are only unique within their host; `:` cannot occur in a host name. */
function qualified(host: string | undefined, name: string): string {
	return host === undefined ? name : `${host}:${name}`;
}

/** The session a file's usage belongs to (subagents count toward their parent), as `ownerKey`. */
export function ownerSessionId(file: FileUsage): string | undefined {
	const id = file.kind === "subagent" ? file.parentSessionId : file.sessionId;
	return id === undefined ? undefined : ownerKey(file.host, id);
}

/** Identifies a session of `host` (undefined: this machine) in `byOwner`. */
export function ownerKey(host: string | undefined, sessionId: string): string {
	return qualified(host, sessionId);
}

export interface UsageIndexOptions {
	sessionRoot: string;
	cachePath: string;
	retentionMs: number;
	onUpdate: (update: IndexUpdate) => void;
}

export class UsageIndex {
	/** This machine's files by path, and remote hosts' by `host:path`. */
	readonly files = new Map<string, FileUsage>();
	scanned = false;
	scanning = false;
	lastScanMs = 0;
	private worker?: Worker;
	/** Remote hosts whose relay has finished a scan of its session files. */
	private readonly scannedHosts = new Set<string>();
	private readonly options: UsageIndexOptions;

	constructor(options: UsageIndexOptions) {
		this.options = options;
	}

	start(): void {
		this.worker = new Worker(new URL("./index-worker.ts", import.meta.url), { workerData: { cachePath: this.options.cachePath } });
		this.worker.unref();
		this.worker.on("message", (update: IndexUpdate) => this.apply(update));
		this.worker.on("error", () => {
			this.scanning = false;
		});
	}

	scan(subagentCwds: readonly string[]): void {
		if (!this.worker || this.scanning) return;
		this.scanning = true;
		const request: ScanRequest = { type: "scan", sessionRoot: this.options.sessionRoot, subagentCwds: [...subagentCwds], retentionMs: this.options.retentionMs };
		this.worker.postMessage(request);
	}

	close(): Promise<number> | undefined {
		return this.worker?.terminate();
	}

	/** Load updates directly (used by tests without a worker). */
	apply(update: IndexUpdate): void {
		for (const file of update.changed) this.files.set(file.path, file);
		for (const path of update.removed) this.files.delete(path);
		if (update.scanned) {
			this.scanning = false;
			this.scanned = true;
			this.lastScanMs = update.durationMs;
		}
		this.options.onUpdate(update);
	}

	/** Applies a remote host's relay update. The caller notifies its own listeners. */
	applyRemote(host: string, delta: UsageDelta): void {
		if (delta.reset) {
			for (const [key, file] of this.files) if (file.host === host) this.files.delete(key);
			this.scannedHosts.delete(host);
		}
		for (const file of delta.changed) this.files.set(qualified(host, file.path), { ...file, host });
		for (const path of delta.removed) this.files.delete(qualified(host, path));
		if (delta.scanned) this.scannedHosts.add(host);
	}

	hostScanned(host: string): boolean {
		return this.scannedHosts.has(host);
	}

	private forEachBucket(sinceMs: number, visit: (file: FileUsage, hour: number, model: string, bucket: UsageBucket) => void, untilMs = Number.POSITIVE_INFINITY): void {
		const first = Math.floor(sinceMs / HOUR_MS);
		const last = Number.isFinite(untilMs) ? Math.floor(untilMs / HOUR_MS) : Number.POSITIVE_INFINITY;
		for (const file of this.files.values()) {
			for (const [hourKey, models] of Object.entries(file.hours)) {
				const hour = Number(hourKey);
				if (hour < first || hour > last) continue;
				for (const [model, bucket] of Object.entries(models)) visit(file, hour, model, bucket);
			}
		}
	}

	total(sinceMs: number): UsageBucket {
		const sum = emptyBucket();
		this.forEachBucket(sinceMs, (_file, _hour, _model, bucket) => addBucket(sum, bucket));
		return sum;
	}

	/** Usage grouped by owning session id (subagents folded into their parent). */
	byOwner(sinceMs: number, provider?: string): Map<string, { file: FileUsage; usage: UsageBucket }> {
		const owners = new Map<string, { file: FileUsage; usage: UsageBucket }>();
		this.forEachBucket(sinceMs, (file, _hour, model, bucket) => {
			if (provider && !model.startsWith(`${provider}/`)) return;
			const owner = ownerSessionId(file) ?? qualified(file.host, file.path);
			let entry = owners.get(owner);
			if (!entry) {
				entry = { file, usage: emptyBucket() };
				owners.set(owner, entry);
			}
			if (file.kind === "session") entry.file = file;
			addBucket(entry.usage, bucket);
		});
		return owners;
	}

	byModel(sinceMs: number): Map<string, UsageBucket> {
		const models = new Map<string, UsageBucket>();
		this.forEachBucket(sinceMs, (_file, _hour, model, bucket) => {
			let entry = models.get(model);
			if (!entry) {
				entry = emptyBucket();
				models.set(model, entry);
			}
			addBucket(entry, bucket);
		});
		return models;
	}

	/** Cost or tokens per `bucketHours` from `sinceMs` to `untilMs`, oldest first. */
	series(sinceMs: number, untilMs: number, bucketHours: number, metric: "cost" | "tokens"): number[] {
		const first = Math.floor(sinceMs / HOUR_MS);
		const count = Math.max(1, Math.ceil((Math.floor(untilMs / HOUR_MS) - first + 1) / bucketHours));
		const values = new Array<number>(count).fill(0);
		this.forEachBucket(
			sinceMs,
			(_file, hour, _model, bucket) => {
				const index = Math.floor((hour - first) / bucketHours);
				if (index >= 0 && index < count) values[index] += bucket[metric];
			},
			untilMs,
		);
		return values;
	}

	/** Usage per host (undefined: this machine); hosts without usage are absent. */
	byHost(sinceMs: number): Map<string | undefined, UsageBucket> {
		const hosts = new Map<string | undefined, UsageBucket>();
		this.forEachBucket(sinceMs, (file, _hour, _model, bucket) => {
			let entry = hosts.get(file.host);
			if (!entry) {
				entry = emptyBucket();
				hosts.set(file.host, entry);
			}
			addBucket(entry, bucket);
		});
		return hosts;
	}

	/** All retained subagent usage spawned by `sessionId` on `host` (undefined: this machine). */
	subagentUsage(host: string | undefined, sessionId: string): UsageBucket {
		const sum = emptyBucket();
		for (const file of this.files.values()) {
			if (file.kind !== "subagent" || file.host !== host || file.parentSessionId !== sessionId) continue;
			for (const models of Object.values(file.hours)) for (const bucket of Object.values(models)) addBucket(sum, bucket);
		}
		return sum;
	}

	/** Project directories of this machine's files. */
	cwds(): string[] {
		return [...new Set([...this.files.values()].flatMap((file) => (file.host === undefined && file.cwd ? [file.cwd] : [])))];
	}
}
