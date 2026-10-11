// The phone's usage tab: the dashboard's usage view, as data. Like the view, it counts this machine's session
// files and logins only.
import { rowLabel } from "../manager/model/store.ts";
import type { ManagerRuntime } from "../manager/runtime.ts";
import { bucketHours, cacheHit, quotaShares, rangeStart, rankedModels, rankedOwners, sessionTitle, USAGE_RANGES, type UsageMetric } from "../manager/usage/report.ts";
import type { FileUsage } from "../manager/usage/types.ts";
import { clean } from "./sessions.ts";

/** A quota window names its largest sessions; the rest of the window is everyone else. */
const QUOTA_SHARES = 4;
const SESSIONS = 50;
const MODELS = 5;

export function usageReport(runtime: ManagerRuntime, now = Date.now()) {
	const index = runtime.usage;
	const open = new Map<string, string>();
	for (const row of runtime.store.rows.values()) if (row.bridge) open.set(row.bridge.sessionId, rowLabel(row));
	const label = (owner: string, file: FileUsage) => {
		const { project, title } = sessionTitle(file);
		return clean(open.get(owner) ?? (title ? `${project} › ${title}` : project), 200);
	};
	return {
		at: now,
		indexing: !index.scanned,
		quota: runtime.quota.windows.map((window) => {
			const shares = quotaShares(index, window, now);
			const total = shares.reduce((sum, share) => sum + share.weight, 0);
			return {
				provider: clean(window.providerLabel, 100),
				window: window.label,
				usedPercent: window.usedPercent,
				resetAt: window.resetAt > now ? window.resetAt : null,
				exhaustedUntil: window.exhaustedUntil !== undefined && window.exhaustedUntil > now ? window.exhaustedUntil : null,
				shares: shares.slice(0, QUOTA_SHARES).map((share) => ({ label: label(share.owner, share.file), open: open.has(share.owner), share: share.weight / total })),
			};
		}),
		ranges: USAGE_RANGES.map((range) => {
			const since = rangeStart(range, now);
			const hours = bucketHours(range);
			const total = index.total(since);
			const measure = (metric: UsageMetric) => ({
				series: index.series(since, now, hours, metric),
				sessions: rankedOwners(index, since, metric)
					.slice(0, SESSIONS)
					.map(({ owner, file, usage }) => ({ label: label(owner, file), open: open.has(owner), value: usage[metric] })),
				models: rankedModels(index, since, metric)
					.slice(0, MODELS)
					.map(({ model, value }) => ({ name: clean(model, 200), value })),
			});
			return { range, bucketHours: hours, total: { cost: total.cost, tokens: total.tokens, cacheHit: cacheHit(total) }, cost: measure("cost"), tokens: measure("tokens") };
		}),
	};
}
