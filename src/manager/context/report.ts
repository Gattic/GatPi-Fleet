// Shared context composition report for the terminal dashboard and the phone gateway.
// Totals stay pi's measurement; parts are estimates and unknown values are never invented.
import type { SessionRow } from "../model/store.ts";
import { rowLabel } from "../model/store.ts";
import type { UsageIndex } from "../usage/usage-index.ts";
import { ownerKey, ownerSessionId, USAGE_RETENTION_MS } from "../usage/usage-index.ts";
import { sessionTitle, startOfToday } from "../usage/report.ts";
import type { ContextBreakdown, ContextParts } from "../../protocol/index.ts";
import type { ContextWindows } from "./windows.ts";

/** Fixed category order, shared by every client. */
export const CONTEXT_PART_KEYS = ["system", "tools", "injected", "user", "assistant", "toolResults", "summary"] as const;
export type ContextPartKey = (typeof CONTEXT_PART_KEYS)[number];

export type ContextScope = "open" | "today" | "30d";
export const CONTEXT_SCOPES: readonly ContextScope[] = ["open", "today", "30d"];

export function partsTotal(parts: ContextParts): number {
	return CONTEXT_PART_KEYS.reduce((sum, key) => sum + parts[key], 0);
}

export interface ContextSessionRow {
	/** The gateway's opaque session reference for a live row; absent for ended and unbridged rows. */
	id?: string;
	label: string;
	host?: string;
	model?: string;
	tokens: number | null;
	window: number | null;
	percent: number | null;
	compactAt: number | null;
	breakdown?: ContextBreakdown;
	live: boolean;
	unbridged: boolean;
	at?: number;
}

export interface ContextSources {
	store: { ordered(): readonly SessionRow[] };
	usage: UsageIndex;
	windows: ContextWindows;
	/** Remote host names in hosts.json order; the gateway's own machine is always first. */
	hostOrder: readonly string[];
	now: number;
	/** Optional opaque id for live bridged rows, supplied by a client that has one. */
	identify?: (row: SessionRow) => string | undefined;
}

/** Every session in scope: open rows from the store, ended rows from the usage index (fill only). */
export function contextRows(sources: ContextSources, scope: ContextScope): ContextSessionRow[] {
	const rows: ContextSessionRow[] = [];
	const openOwners = new Map<string, string>();
	for (const row of sources.store.ordered()) {
		if (row.exitedAt !== undefined) continue;
		if (!row.bridge) {
			rows.push({ label: rowLabel(row), tokens: null, window: null, percent: null, compactAt: null, live: true, unbridged: true, host: row.host });
			continue;
		}
		openOwners.set(ownerKey(row.host, row.bridge.sessionId), rowLabel(row));
		const context = row.bridge.context;
		rows.push({
			id: sources.identify?.(row),
			label: rowLabel(row),
			host: row.host,
			model: row.bridge.model,
			tokens: context?.tokens ?? null,
			window: context?.window ?? null,
			percent: context?.percent ?? null,
			compactAt: context?.breakdown?.compactAt ?? null,
			breakdown: context?.breakdown,
			live: true,
			unbridged: false,
			at: context?.breakdown?.at,
		});
	}
	if (scope !== "open") {
		const since = scope === "today" ? startOfToday(sources.now) : sources.now - USAGE_RETENTION_MS;
		for (const file of sources.usage.files.values()) {
			if (file.kind !== "session" || file.mtimeMs < since) continue;
			const owner = ownerSessionId(file);
			if (owner && openOwners.has(owner)) continue;
			const { project, title } = sessionTitle(file);
			const context = file.context;
			const window = context ? sources.windows.window(context.model) : null;
			const tokens = context?.tokens ?? null;
			rows.push({
				label: title ? `${project} › ${title}` : project,
				host: file.host,
				model: context?.model,
				tokens,
				window,
				percent: tokens !== null && window !== null && window > 0 ? (tokens / window) * 100 : null,
				compactAt: null,
				live: false,
				unbridged: false,
				at: context?.at,
			});
		}
	}
	return rows.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.label.localeCompare(b.label));
}

export interface CumulativeContext {
	parts: ContextParts;
	compositionTokens: number;
	unattributed: number | null;
	imageTokens: number;
	imageBlocks: number;
	fillTokens: number;
	fillWindows: number;
	near: number;
	unknown: number;
	unbridged: number;
	endedTokens: number;
	endedSessions: number;
	hosts: { host?: string; tokens: number }[];
	models: { model: string; tokens: number; sessions: number }[];
}

export function cumulativeContext(rows: readonly ContextSessionRow[], hostOrder: readonly string[]): CumulativeContext {
	const parts: ContextParts = { system: 0, tools: 0, injected: 0, user: 0, assistant: 0, toolResults: 0, summary: 0 };
	let compositionTokens = 0;
	let unattributed: number | null = null;
	let imageTokens = 0;
	let imageBlocks = 0;
	let fillTokens = 0;
	let fillWindows = 0;
	let near = 0;
	let unknown = 0;
	let unbridged = 0;
	let endedTokens = 0;
	let endedSessions = 0;
	const hosts = new Map<string | undefined, number>();
	const models = new Map<string, { tokens: number; sessions: number }>();
	for (const row of rows) {
		if (row.breakdown) {
			for (const key of CONTEXT_PART_KEYS) parts[key] += row.breakdown.parts[key];
			if (row.tokens !== null) compositionTokens += row.tokens;
			if (row.breakdown.unattributed !== null) unattributed = (unattributed ?? 0) + row.breakdown.unattributed;
			imageTokens += row.breakdown.imageTokens;
			imageBlocks += row.breakdown.counts.imageBlocks;
		}
		if (row.tokens !== null && row.window !== null && row.window > 0) {
			fillTokens += row.tokens;
			fillWindows += row.window;
		}
		if (row.percent !== null && row.percent >= 80) near++;
		if (row.tokens === null && !row.unbridged) unknown++;
		if (row.unbridged) unbridged++;
		if (!row.live && row.tokens !== null) {
			endedTokens += row.tokens;
			endedSessions++;
		}
		if (row.tokens !== null) {
			hosts.set(row.host, (hosts.get(row.host) ?? 0) + row.tokens);
			if (row.model) {
				const model = row.model.split("/").pop() ?? row.model;
				const entry = models.get(model) ?? { tokens: 0, sessions: 0 };
				entry.tokens += row.tokens;
				entry.sessions++;
				models.set(model, entry);
			}
		}
	}
	const hostIndex = (host: string | undefined): number => {
		if (host === undefined) return 0;
		const index = hostOrder.indexOf(host);
		return index >= 0 ? index + 1 : hostOrder.length + 1;
	};
	const orderedHosts = [...hosts.entries()]
		.filter(([, tokens]) => tokens > 0)
		.sort((a, b) => hostIndex(a[0]) - hostIndex(b[0]) || (a[0] ?? "").localeCompare(b[0] ?? ""))
		.map(([host, tokens]) => ({ host, tokens }));
	return {
		parts,
		compositionTokens,
		unattributed,
		imageTokens,
		imageBlocks,
		fillTokens,
		fillWindows,
		near,
		unknown,
		unbridged,
		endedTokens,
		endedSessions,
		hosts: orderedHosts,
		models: [...models.entries()].map(([model, entry]) => ({ model, ...entry })).sort((a, b) => b.tokens - a.tokens),
	};
}
