// Usage aggregates shown by the dashboard's usage view and served to the phone by the gateway.
import { basename } from "node:path";
import type { RemoteHost } from "../remote/host.ts";
import type { FileUsage, UsageBucket } from "./types.ts";
import type { UsageIndex } from "./usage-index.ts";

export type UsageRange = "today" | "7d" | "30d";
export const USAGE_RANGES: UsageRange[] = ["today", "7d", "30d"];
/** What usage is measured in: pi's API-equivalent cost, or tokens (the only measure for models without a price). */
export type UsageMetric = "cost" | "tokens";
export const USAGE_METRICS: UsageMetric[] = ["cost", "tokens"];

const HOUR_MS = 3_600_000;

export function startOfToday(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * Today starts at local midnight. 7 and 30 days are whole hours ending with the current one, so their 6-hour and
 * daily chart buckets are whole too, and the last bucket holds the latest 6 or 24 hours rather than the current hour alone.
 */
export function rangeStart(range: UsageRange, now: number): number {
	if (range === "today") return startOfToday(now);
	const hours = (range === "7d" ? 7 : 30) * 24;
	return (Math.floor(now / HOUR_MS) + 1 - hours) * HOUR_MS;
}

/** Hours per chart bucket: hourly for today, 6-hourly for 7 days, daily for 30 days. */
export function bucketHours(range: UsageRange): number {
	return range === "today" ? 1 : range === "7d" ? 6 : 24;
}

/** The part of prompt tokens read from the provider's cache. */
export function cacheHit(usage: UsageBucket): number {
	return usage.prompt > 0 ? usage.cacheRead / usage.prompt : 0;
}

/** A session's usage; `owner` is its session id (subagents count toward the session that spawned them). */
export interface OwnerUsage {
	owner: string;
	file: FileUsage;
	usage: UsageBucket;
}

/** Sessions with usage since `sinceMs`, largest first. In cost, sessions below half a cent round to nothing and are left out; any token counts. */
export function rankedOwners(index: UsageIndex, sinceMs: number, metric: UsageMetric): OwnerUsage[] {
	return [...index.byOwner(sinceMs).entries()]
		.map(([owner, entry]) => ({ owner, ...entry }))
		.filter((entry) => (metric === "cost" ? entry.usage.cost >= 0.005 : entry.usage.tokens > 0))
		.sort((a, b) => b.usage[metric] - a.usage[metric]);
}

/** Usage per model since `sinceMs`, largest first. One model reached through several accounts (e.g. codex and codex#2) is one model. */
export function rankedModels(index: UsageIndex, sinceMs: number, metric: UsageMetric): { model: string; value: number }[] {
	const models = new Map<string, number>();
	for (const [key, usage] of index.byModel(sinceMs)) {
		const model = key.split("/").pop() ?? key;
		models.set(model, (models.get(model) ?? 0) + usage[metric]);
	}
	return [...models.entries()].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([model, value]) => ({ model, value }));
}

/** Usage per machine since `sinceMs`: this machine (`host` undefined) first, then every one of `hosts`, in order, with or without usage. */
export function hostUsage(index: UsageIndex, sinceMs: number, metric: UsageMetric, hosts: readonly string[]): { host: string | undefined; value: number }[] {
	const byHost = index.byHost(sinceMs);
	return [undefined, ...hosts].map((host) => ({ host, value: byHost.get(host)?.[metric] ?? 0 }));
}

/** A connected remote host that has not finished a first scan of its session files. */
export function hostIndexing(index: UsageIndex, remote: RemoteHost): boolean {
	return remote.status.kind === "online" && !index.hostScanned(remote.name);
}

/** True until this machine and every connected remote host have finished a first scan; a host that is not connected is not waited for. */
export function indexing(index: UsageIndex, remotes: Iterable<RemoteHost>): boolean {
	return !index.scanned || [...remotes].some((remote) => hostIndexing(index, remote));
}

/** How a session that is no longer open is named: by project (and host, as `project@host`) and its name (or first prompt), so sessions of one project stay apart. */
export function sessionTitle(file: FileUsage): { project: string; title?: string } {
	const project = file.cwd ? basename(file.cwd) : "unknown";
	return { project: file.host === undefined ? project : `${project}@${file.host}`, title: file.name ?? file.firstPrompt };
}
