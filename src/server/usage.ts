// The phone's usage tab: the dashboard's usage view, as data. Spend counts the session files of this machine
// and of its remote hosts; quotas are this machine's logins.
import { providerLabel } from "../manager/collectors/quota.ts";
import { rowLabel } from "../manager/model/store.ts";
import type { ManagerRuntime } from "../manager/runtime.ts";
import { bucketHours, cacheHit, hostIndexing, hostUsage, indexing, rangeStart, rankedModels, rankedOwners, sessionTitle, USAGE_RANGES, type UsageMetric } from "../manager/usage/report.ts";
import type { FileUsage } from "../manager/usage/types.ts";
import { ownerKey } from "../manager/usage/usage-index.ts";
import { clean } from "./sessions.ts";

const SESSIONS = 50;
const MODELS = 5;

export function usageReport(runtime: ManagerRuntime, now = Date.now()) {
	const index = runtime.usage;
	const open = new Map<string, string>();
	for (const row of runtime.store.rows.values()) if (row.bridge) open.set(ownerKey(row.host, row.bridge.sessionId), rowLabel(row));
	const remotes = [...runtime.network.remotes.values()];
	const label = (owner: string, file: FileUsage) => {
		const { project, title } = sessionTitle(file);
		return clean(open.get(owner) ?? (title ? `${project} › ${title}` : project), 200);
	};
	return {
		at: now,
		indexing: indexing(index, remotes),
		hosts: remotes.map((remote) => ({ host: remote.name, status: remote.status.kind, indexing: hostIndexing(index, remote) })),
		quota: runtime.quota.snapshot(now)?.map((account) => ({ ...account, provider: clean(providerLabel(account.provider), 100) })) ?? null,
		cooldowns: runtime.quota.activeCooldowns(now)?.map(({ provider, until }) => ({ provider: clean(providerLabel(provider), 100), until })) ?? null,
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
				hosts: hostUsage(index, since, metric, remotes.map((remote) => remote.name)).map(({ host, value }) => ({ host: host ?? null, value })),
			});
			return { range, bucketHours: hours, total: { cost: total.cost, tokens: total.tokens, cacheHit: cacheHit(total) }, cost: measure("cost"), tokens: measure("tokens") };
		}),
	};
}
