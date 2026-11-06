// The phone's context tab: per-session measured context and estimated composition, plus cumulative
// totals over open, today and 30-day scopes. No prompt, transcript or tool-output text is projected.
import { CONTEXT_SCOPES, contextRows, cumulativeContext } from "../manager/context/report.ts";
import type { ManagerRuntime } from "../manager/runtime.ts";
import { breakdownProjection, clean, sessionRef } from "./sessions.ts";

export function contextReport(runtime: ManagerRuntime, now = Date.now()) {
	const sources = {
		store: runtime.store,
		usage: runtime.usage,
		windows: runtime.windows,
		hostOrder: [...runtime.network.remotes.keys()],
		now,
		identify: sessionRef,
	};
	return {
		at: now,
		scopes: CONTEXT_SCOPES.map((scope) => {
			const rows = contextRows(sources, scope);
			const total = cumulativeContext(rows, sources.hostOrder);
			return {
				scope,
				rows: rows.map((row) => ({
					id: row.id ?? null,
					label: clean(row.label, 200),
					host: row.host ?? null,
					model: clean(row.model, 200),
					tokens: row.tokens,
					window: row.window,
					percent: row.percent,
					compactAt: row.compactAt,
					live: row.live,
					unbridged: row.unbridged,
					at: row.at ?? null,
					breakdown: row.breakdown ? breakdownProjection(row.breakdown) : null,
				})),
				cumulative: {
					parts: total.parts,
					compositionTokens: total.compositionTokens,
					unattributed: total.unattributed,
					imageTokens: total.imageTokens,
					imageBlocks: total.imageBlocks,
					fillTokens: total.fillTokens,
					fillWindows: total.fillWindows,
					near: total.near,
					unknown: total.unknown,
					unbridged: total.unbridged,
					endedTokens: total.endedTokens,
					endedSessions: total.endedSessions,
					hosts: total.hosts.map(({ host, tokens }) => ({ host: host ?? null, tokens })),
					models: total.models.map(({ model, tokens, sessions }) => ({ model: clean(model, 200), tokens, sessions })),
				},
			};
		}),
	};
}
