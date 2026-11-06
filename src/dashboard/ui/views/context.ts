// Context composition for the detail block and the context view. The total is pi's measurement;
// every part is an estimate, so the UI must label estimates and never invent a zero.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionRow } from "../../../manager/model/store.ts";
import { rowLabel } from "../../../manager/model/store.ts";
import { ownerKey, ownerSessionId, USAGE_RETENTION_MS } from "../../../manager/usage/usage-index.ts";
import { sessionTitle, startOfToday } from "../../../manager/usage/report.ts";
import type { ContextBreakdown, ContextParts } from "../../../protocol/index.ts";
import { gauge, hbar, stackedBar } from "../charts.ts";
import { ELLIPSIS, fit, fitRight, fmtTokens } from "../format.ts";
import { theme, type Paint } from "../theme.ts";
import { FIELD_WIDTH, field, rule, titleBar, type ViewContext } from "./shared.ts";

interface PartSpec {
	key: keyof ContextParts;
	label: string;
	paint: Paint;
}

/** Fixed category order, shared by the bar and the legend. */
export const CONTEXT_PARTS: readonly PartSpec[] = [
	{ key: "system", label: "system", paint: theme.dim },
	{ key: "tools", label: "tools", paint: theme.accent },
	{ key: "injected", label: "injected", paint: theme.waiting },
	{ key: "user", label: "user", paint: theme.working },
	{ key: "assistant", label: "assistant", paint: theme.direct },
	{ key: "toolResults", label: "tool results", paint: theme.indirect },
	{ key: "summary", label: "summary", paint: theme.muted },
];

const INDENT = " ".repeat(FIELD_WIDTH);

export function partsTotal(parts: ContextParts): number {
	return CONTEXT_PARTS.reduce((sum, part) => sum + parts[part.key], 0);
}

/** Stacked bar over the window; a positive residual is drawn after the estimated parts. */
export function contextBar(breakdown: ContextBreakdown, window: number, width: number): string {
	const segments = CONTEXT_PARTS.map((part) => ({ value: breakdown.parts[part.key], paint: part.paint }));
	if (breakdown.unattributed !== null && breakdown.unattributed > 0) segments.push({ value: breakdown.unattributed, paint: theme.border });
	return stackedBar(segments, window > 0 ? window : partsTotal(breakdown.parts), width);
}

/** Percentages are shares of the estimated parts, so they sum to 100. */
function legend(breakdown: ContextBreakdown, width: number): string {
	const total = partsTotal(breakdown.parts);
	const parts = CONTEXT_PARTS.filter((part) => breakdown.parts[part.key] > 0);
	if (!parts.length) return fit(`${INDENT}${theme.dim("est.")} ${theme.dim("no projected parts")}`, width);
	const share = (part: PartSpec) => `${Math.round((breakdown.parts[part.key] / total) * 100)}%`;
	const text = width >= 100
		? parts.map((part) => `${part.paint("■")} ${theme.muted(part.label)} ${theme.text(share(part))}`).join("  ")
		: parts.map((part) => `${theme.muted(part.label)} ${theme.text(share(part))}`).join("  ");
	return fit(`${INDENT}${theme.dim("est.")} ${text}`, width);
}

function residual(breakdown: ContextBreakdown): string {
	if (breakdown.unattributed === null) return theme.dim("unattributed unknown");
	const value = breakdown.unattributed;
	const sign = value < 0 ? "−" : "+";
	const amount = `${sign}${fmtTokens(Math.abs(value))}`;
	const percent = breakdown.totalBasis === "measured" ? Math.round((value / Math.max(1, partsTotal(breakdown.parts) + value)) * 100) : null;
	return `${theme.muted("unattributed")} ${theme.text(amount)}${percent === null ? "" : theme.dim(` (${percent}%)`)}`;
}

function countsLine(breakdown: ContextBreakdown, width: number): string {
	const counts = breakdown.counts;
	const items = [
		`${counts.user} user`,
		`${counts.assistant} assistant`,
		`${counts.toolResults} tool results`,
		`${counts.injected} injected`,
		`${counts.imageBlocks} image${counts.imageBlocks === 1 ? "" : "s"}`,
	].filter((item) => !item.startsWith("0 "));
	return fit(`${INDENT}${residual(breakdown)}${items.length ? theme.dim(" · ") : ""}${theme.dim(items.join(" · "))}`, width);
}

/**
 * The detail view's context block: ≤ 4 rows, one summary row when the bridge has no breakdown.
 * The bar is drawn over the window, so the empty track is the headroom, not a share of the parts.
 */
export function contextLines(row: SessionRow, width: number): string[] {
	const context = row.bridge?.context;
	if (!context) return [];
	const breakdown = context.breakdown;
	if (!breakdown) {
		const fraction = context.percent === null ? 0 : context.percent / 100;
		const fill = context.tokens === null
			? theme.dim("unknown")
			: `${theme.text(`${fmtTokens(context.tokens)} / ${fmtTokens(context.window)}`)} ${theme.muted(context.percent === null ? "—" : `${Math.round(context.percent)}%`)}`;
		return [fit(`${field("CTX")}${gauge(fraction, 12)} ${fill} ${theme.dim("· breakdown needs /reload")}`, width)];
	}

	const barWidth = width >= 120 ? 14 : width >= 100 ? 10 : 6;
	const bar = contextBar(breakdown, context.window, barWidth);
	const threshold = breakdown.compactAt === null
		? theme.dim("compaction off")
		: context.tokens === null
			? theme.dim(`compacts at ${fmtTokens(breakdown.compactAt)}`)
			: breakdown.compactAt >= context.tokens
				? `${theme.muted(`compacts at ${fmtTokens(breakdown.compactAt)}`)} ${theme.dim(`(${fmtTokens(breakdown.compactAt - context.tokens)} headroom)`)}`
				: theme.error(`over compact threshold by ${fmtTokens(context.tokens - breakdown.compactAt)}`);

	const total = context.tokens === null
		? `${theme.dim("unknown until the next response")} ${theme.dim("· estimate")}`
		: (() => {
			const percent = context.percent;
			const paint = percent !== null && percent > 100 ? theme.error : percent !== null && percent >= 80 ? theme.waiting : theme.muted;
			return `${theme.text(`${fmtTokens(context.tokens)} / ${fmtTokens(context.window)}`)} ${paint(percent === null ? "—" : `${Math.round(percent)}%`)}`;
		})();
	return [
		fit(`${field("CTX")}${bar} ${total}   ${threshold}`, width),
		legend(breakdown, width),
		countsLine(breakdown, width),
	];
}

export type ContextScope = "open" | "today" | "30d";
export const CONTEXT_SCOPES: readonly ContextScope[] = ["open", "today", "30d"];

interface ContextSessionRow {
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

/** Every session in scope: open rows from the store, ended rows from the usage index (fill only). */
export function contextRows(ctx: ViewContext, scope: ContextScope): ContextSessionRow[] {
	const rows: ContextSessionRow[] = [];
	const openOwners = new Map<string, string>();
	for (const row of ctx.store.ordered()) {
		if (row.exitedAt !== undefined) continue;
		if (!row.bridge) {
			rows.push({ label: rowLabel(row), tokens: null, window: null, percent: null, compactAt: null, live: true, unbridged: true, host: row.host });
			continue;
		}
		openOwners.set(ownerKey(row.host, row.bridge.sessionId), rowLabel(row));
		const context = row.bridge.context;
		rows.push({
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
		});
	}
	if (scope !== "open") {
		const since = scope === "today" ? startOfToday(ctx.now) : ctx.now - USAGE_RETENTION_MS;
		for (const file of ctx.usage.files.values()) {
			if (file.kind !== "session" || file.mtimeMs < since) continue;
			const owner = ownerSessionId(file);
			if (owner && openOwners.has(owner)) continue;
			const { project, title } = sessionTitle(file);
			const context = file.context;
			const window = context ? ctx.windows.window(context.model) : null;
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

export function contextRowCount(ctx: ViewContext, scope: ContextScope): number {
	return contextRows(ctx, scope).length;
}

/** Session rows visible below the fixed header and column labels, above the narrow summary. */
export function contextVisibleRows(width: number, height: number): number {
	const content = Math.max(1, height - 1 - 4);
	return width < 100 ? Math.max(1, content - 6) : Math.max(1, content - 1);
}

interface CumulativeContext {
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

function cumulative(rows: readonly ContextSessionRow[], ctx: ViewContext): CumulativeContext {
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
			for (const part of CONTEXT_PARTS) parts[part.key] += row.breakdown.parts[part.key];
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
	const hostOrder = [undefined, ...ctx.remotes.keys()];
	const orderedHosts = [...hosts.entries()]
		.filter(([, tokens]) => tokens > 0)
		.sort((a, b) => {
			const ai = hostOrder.indexOf(a[0]);
			const bi = hostOrder.indexOf(b[0]);
			return (ai < 0 ? hostOrder.length : ai) - (bi < 0 ? hostOrder.length : bi) || (a[0] ?? "").localeCompare(b[0] ?? "");
		})
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

function scopeLabel(scope: ContextScope, rows: readonly ContextSessionRow[]): string {
	const live = rows.filter((row) => row.live && !row.unbridged).length;
	const ended = rows.filter((row) => !row.live).length;
	if (scope === "open") return `open ${live}`;
	if (scope === "today") return `open ${live} + ended today ${ended}`;
	return `retained 30 days · ${live} open + ${ended} ended`;
}

function scopeChips(scope: ContextScope): string {
	return CONTEXT_SCOPES.map((option) => (option === scope ? theme.chip(theme.bold(theme.text(` ${option} `))) : theme.dim(` ${option} `))).join("");
}

function hostName(ctx: ViewContext, host: string | undefined): string {
	if (host === undefined) return theme.text("this machine");
	const name = truncateToWidth(host, 15, ELLIPSIS);
	const remote = ctx.remotes.get(host);
	if (!remote) return theme.muted(name);
	switch (remote.status.kind) {
		case "online": return `${theme.text(name)}${ctx.usage.hostScanned(host) ? "" : theme.waiting(" …")}`;
		case "offline": return `${theme.muted(name)}${theme.error(" ✖")}`;
		case "connecting": return `${theme.muted(name)}${theme.dim(" …")}`;
	}
}

function percentOf(value: number, total: number): number | null {
	return total > 0 ? Math.round((value / total) * 100) : null;
}

function signed(value: number): string {
	return `${value < 0 ? "−" : "+"}${fmtTokens(Math.abs(value))}`;
}

function sessionColumn(rows: readonly ContextSessionRow[], width: number, visible: number, offset: number): string[] {
	const barWidth = Math.max(4, Math.min(12, Math.floor(width * 0.16)));
	const tokenWidth = 6;
	const windowWidth = 6;
	const fillWidth = 4;
	const compactWidth = 8;
	const labelWidth = Math.max(8, width - barWidth - tokenWidth - windowWidth - fillWidth - compactWidth - 5);
	const start = Math.max(0, Math.min(offset, Math.max(0, rows.length - visible)));
	const end = Math.min(rows.length, start + visible);
	const position = rows.length > visible ? theme.dim(` ${start + 1}-${end}/${rows.length}`) : "";
	const header = `${fit(`${theme.muted("BY SESSION")}${position}`, labelWidth)} ${fit(theme.dim("CTX"), barWidth)} ${fitRight(theme.dim("TOKENS"), tokenWidth)} ${fitRight(theme.dim("WINDOW"), windowWidth)} ${fitRight(theme.dim("FILL"), fillWidth)} ${fitRight(theme.dim("COMPACT"), compactWidth)}`;
	const lines = [fit(header, width)];
	if (!rows.length) lines.push(fit(theme.dim("no sessions"), width));
	for (const row of rows.slice(start, end)) {
		const bar = row.breakdown ? contextBar(row.breakdown, row.window ?? 0, barWidth) : theme.faint("░".repeat(barWidth));
		const tokens = row.tokens === null ? theme.dim("—") : theme.text(fmtTokens(row.tokens));
		const window = row.window === null ? theme.dim("—") : theme.dim(fmtTokens(row.window));
		const percent = row.percent === null ? "—" : `${Math.round(row.percent)}%`;
		const paint = row.percent !== null && row.percent > 100 ? theme.error : row.percent !== null && row.percent >= 80 ? theme.waiting : theme.text;
		const compact = row.compactAt === null ? theme.dim("—") : theme.dim(fmtTokens(row.compactAt));
		const mark = row.unbridged
			? theme.waiting(" · no bridge")
			: row.tokens === null
				? theme.dim(" · unknown")
				: row.breakdown ? "" : theme.dim(" · no breakdown");
		const nameWidth = Math.max(8, labelWidth - visibleWidth(mark));
		const label = `${truncateToWidth(row.label, nameWidth, ELLIPSIS)}${mark}`;
		lines.push(`${fit(label, labelWidth)} ${bar} ${fitRight(tokens, tokenWidth)} ${fitRight(window, windowWidth)} ${fitRight(paint(percent), fillWidth)} ${fitRight(compact, compactWidth)}`);
	}
	return lines;
}

function cumulativeColumn(ctx: ViewContext, scope: ContextScope, total: CumulativeContext, width: number): string[] {
	const partsTotal = partsTotalOf(total.parts);
	const lines = [fit(`${theme.muted("CUMULATIVE")} ${theme.dim(scope === "open" ? "(open sessions)" : scope === "today" ? "(open + ended today)" : "(retained 30 days)")}`, width)];
	for (const part of CONTEXT_PARTS) {
		const value = total.parts[part.key];
		if (value <= 0) continue;
		const percent = percentOf(value, partsTotal);
		lines.push(`${fit(theme.muted(part.label), 13)} ${hbar(partsTotal > 0 ? value / partsTotal : 0, 1, 10, part.paint)} ${fitRight(theme.text(`${percent ?? 0}%`), 4)} ${fitRight(theme.dim(fmtTokens(value)), 7)}`);
	}
	if (partsTotal <= 0) lines.push(fit(theme.dim("no live breakdowns in scope"), width));
	const residualPercent = total.unattributed === null ? null : percentOf(total.unattributed, total.compositionTokens);
	lines.push(fit(`${fit(theme.muted("unattributed"), 13)} ${total.unattributed === null ? theme.dim("—") : `${theme.text(signed(total.unattributed))}${residualPercent === null ? "" : theme.dim(` (${residualPercent}%)`)}`}`, width));
	const fillPercent = total.fillWindows > 0 ? Math.round((total.fillTokens / total.fillWindows) * 100) : null;
	lines.push(fit(`Σ ${fmtTokens(total.compositionTokens)} measured${fillPercent === null ? "" : theme.dim(` · weighted mean fill ${fillPercent}%`)}${total.fillWindows > 0 ? theme.dim(` across ${fmtTokens(total.fillWindows)} window tokens`) : ""}`, width));
	lines.push(fit(`${theme.text(String(total.near))} ≥ 80% · ${theme.text(String(total.unknown))} unknown · ${theme.text(String(total.unbridged))} unbridged`, width));
	if (scope !== "open") lines.push(fit(`ended (fill only) ${fmtTokens(total.endedTokens)} over ${total.endedSessions}`, width));
	if (total.imageBlocks > 0) {
		const percent = percentOf(total.imageTokens, partsTotal);
		lines.push(fit(`${total.imageBlocks} image block${total.imageBlocks === 1 ? "" : "s"}${percent === null ? "" : ` (${percent}%)`} included in the categories above`, width));
	}
	if (total.hosts.length) lines.push(fit(`BY HOST  ${total.hosts.map(({ host, tokens }) => `${hostName(ctx, host)} ${theme.text(fmtTokens(tokens))}`).join(" · ")}`, width));
	if (total.models.length) lines.push(fit(`BY MODEL  ${total.models.slice(0, 4).map(({ model, tokens, sessions }) => `${theme.text(model)} ${fmtTokens(tokens)} ${theme.dim(`(${sessions})`)}`).join(" · ")}`, width));
	return lines;
}

function partsTotalOf(parts: ContextParts): number {
	return CONTEXT_PARTS.reduce((sum, part) => sum + parts[part.key], 0);
}

function narrowSummary(scope: ContextScope, total: CumulativeContext): string[] {
	const partsTotal = partsTotalOf(total.parts);
	const top = CONTEXT_PARTS
		.map((part) => ({ part, value: total.parts[part.key] }))
		.filter(({ value }) => value > 0)
		.sort((a, b) => b.value - a.value)
		.slice(0, 3)
		.map(({ part, value }) => `${part.label} ${percentOf(value, partsTotal) ?? 0}%`);
	const fillPercent = total.fillWindows > 0 ? Math.round((total.fillTokens / total.fillWindows) * 100) : null;
	const residualPercent = total.unattributed === null ? null : percentOf(total.unattributed, total.compositionTokens);
	return [
		`Σ ${fmtTokens(total.compositionTokens)} measured${fillPercent === null ? "" : ` · fill ${fillPercent}%`} · ${total.near} ≥ 80% · ${total.unknown} unknown · ${total.unbridged} unbridged`,
		`est. ${top.length ? top.join(" · ") : "no live breakdowns"}`,
		`unattributed ${total.unattributed === null ? "—" : `${signed(total.unattributed)}${residualPercent === null ? "" : ` (${residualPercent}%)`}`}${total.imageBlocks ? ` · ${total.imageBlocks} images` : ""}${scope === "open" ? "" : ` · ended ${fmtTokens(total.endedTokens)}`}`,
	];
}

export function renderContext(ctx: ViewContext, width: number, height: number, scope: ContextScope, offset: number): string[] {
	const rows = contextRows(ctx, scope);
	const total = cumulative(rows, ctx);
	const partsTotal = partsTotalOf(total.parts);
	const barWidth = Math.max(4, Math.min(24, Math.floor(width * 0.2)));
	const legend = CONTEXT_PARTS.filter((part) => total.parts[part.key] > 0)
		.map((part) => `${theme.muted(part.label)} ${theme.text(`${percentOf(total.parts[part.key], partsTotal) ?? 0}%`)}`)
		.join(" · ");
	const fillPercent = total.fillWindows > 0 ? Math.round((total.fillTokens / total.fillWindows) * 100) : null;
	const head = `CONTEXT   ${theme.muted(scopeLabel(scope, rows))} · Σ ${theme.text(fmtTokens(total.compositionTokens))} measured${fillPercent === null ? "" : theme.dim(` · weighted mean fill ${fillPercent}%`)}${total.unknown ? theme.dim(` · ${total.unknown} unknown`) : ""}`;
	const bar = `${INDENT}${stackedBar(CONTEXT_PARTS.map((part) => ({ value: total.parts[part.key], paint: part.paint })), partsTotal, barWidth)} ${legend}`;
	const lines = [titleBar(ctx, width, "context"), fit(head, width), fit(bar, width), rule(width, scopeChips(scope))];

	const visible = contextVisibleRows(width, height);
	if (width < 100) {
		lines.push(...sessionColumn(rows, width, visible, offset));
		lines.push(rule(width));
		lines.push(...narrowSummary(scope, total));
	} else {
		const leftWidth = Math.floor((width - 3) / 2);
		const rightWidth = width - 3 - leftWidth;
		const contentRows = Math.max(1, height - 1 - lines.length);
		const left = sessionColumn(rows, leftWidth, Math.max(1, contentRows - 1), offset);
		const right = cumulativeColumn(ctx, scope, total, rightWidth);
		const count = Math.min(Math.max(left.length, right.length), contentRows);
		for (let index = 0; index < count; index++) lines.push(`${fit(left[index] ?? "", leftWidth)} ${theme.faint("│")} ${fit(right[index] ?? "", rightWidth)}`);
	}
	const free = height - 1 - lines.length;
	for (let index = 0; index < free; index++) lines.push("");
	return lines.slice(0, height - 1);
}
