// Main-thread view of the usage index maintained by the index worker.
import { Worker } from "node:worker_threads";
import type { FileUsage, IndexUpdate, ScanRequest, UsageBucket } from "./types.ts";

const HOUR_MS = 3_600_000;

export function emptyBucket(): UsageBucket {
	return { tokens: 0, cost: 0, cacheRead: 0, prompt: 0 };
}

function addBucket(target: UsageBucket, source: UsageBucket): void {
	target.tokens += source.tokens;
	target.cost += source.cost;
	target.cacheRead += source.cacheRead;
	target.prompt += source.prompt;
}

/** The session a file's usage belongs to (subagents count toward their parent). */
export function ownerSessionId(file: FileUsage): string | undefined {
	return file.kind === "subagent" ? file.parentSessionId : file.sessionId;
}

export interface UsageIndexOptions {
	sessionRoot: string;
	cachePath: string;
	retentionMs: number;
	onUpdate: () => void;
}

export class UsageIndex {
	readonly files = new Map<string, FileUsage>();
	scanned = false;
	scanning = false;
	lastScanMs = 0;
	private worker?: Worker;
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
		this.options.onUpdate();
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
			const owner = ownerSessionId(file) ?? file.path;
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

	/** All retained subagent usage spawned by `sessionId`. */
	subagentUsage(sessionId: string): UsageBucket {
		const sum = emptyBucket();
		for (const file of this.files.values()) {
			if (file.kind !== "subagent" || file.parentSessionId !== sessionId) continue;
			for (const models of Object.values(file.hours)) for (const bucket of Object.values(models)) addBucket(sum, bucket);
		}
		return sum;
	}

	cwds(): string[] {
		return [...new Set([...this.files.values()].flatMap((file) => (file.cwd ? [file.cwd] : [])))];
	}
}
