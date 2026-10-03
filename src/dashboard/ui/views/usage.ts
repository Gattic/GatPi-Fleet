import { basename } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { rowLabel } from "../../model/store.ts";
import type { FileUsage, UsageBucket } from "../../usage/types.ts";
import { gauge, hbar, shareBar, stackedArea, stretch } from "../charts.ts";
import { fit, fitRight, fmtCost, fmtDuration, fmtTokens } from "../format.ts";
import { levelColor, type Paint, theme } from "../theme.ts";
import { field, monthAgo, rule, startOfToday, titleBar, type ViewContext, weekAgo } from "./shared.ts";

export type UsageRange = "today" | "7d" | "30d";
export const USAGE_RANGES: UsageRange[] = ["today", "7d", "30d"];
/** What the usage view measures: pi's API-equivalent cost, or tokens (the only measure for models without a price). */
export type UsageMetric = "cost" | "tokens";
export const USAGE_METRICS: UsageMetric[] = ["cost", "tokens"];

const PALETTE: Paint[] = [theme.accent, theme.working, theme.waiting, theme.indirect, theme.error, theme.muted];
const CHART_HEIGHT = 6;

function rangeStart(range: UsageRange, now: number): number {
	if (range === "today") return startOfToday(now);
	return range === "7d" ? weekAgo(now) : monthAgo(now);
}

/** Open sessions by slot and row label. */
function openLabels(ctx: ViewContext): Map<string, string> {
	const labels = new Map<string, string>();
	for (const row of ctx.store.rows.values()) if (row.bridge) labels.set(row.bridge.sessionId, `${row.slot ?? "·"} ${rowLabel(row)}`);
	return labels;
}

/** An open session by its row label; an ended one by project and name (or first prompt), so sessions of one project stay apart. */
function ownerLabel(open: Map<string, string>, owner: string, file: FileUsage, paint?: Paint): string {
	const label = open.get(owner);
	if (label) return (paint ?? theme.text)(label);
	const project = file.cwd ? basename(file.cwd) : "unknown";
	const title = file.name ?? file.firstPrompt;
	if (paint) return paint(title ? `${project} › ${title}` : project);
	return `${theme.muted(project)}${title ? theme.dim(` › ${title}`) : ""}`;
}

/** `text` cut to at most `max` columns, without padding. */
function clip(text: string, max: number): string {
	return fit(text, Math.min(max, visibleWidth(text)));
}

/** Share legend labels get an equal part of the row, but at least this many columns. */
const MIN_LEGEND_LABEL = 12;

function amount(metric: UsageMetric, value: number): string {
	return metric === "cost" ? `$${fmtCost(value)}` : fmtTokens(value);
}

/**
 * Each session's part of a quota window, weighted by cost; providers whose usage in the window has no
 * price are weighted by tokens instead.
 */
export function quotaShares(owners: Map<string, { file: FileUsage; usage: UsageBucket }>): { owner: string; file: FileUsage; weight: number }[] {
	const entries = [...owners.entries()];
	const metric: UsageMetric = entries.some(([, entry]) => entry.usage.cost > 0) ? "cost" : "tokens";
	return entries.map(([owner, entry]) => ({ owner, file: entry.file, weight: entry.usage[metric] })).filter((share) => share.weight > 0).sort((a, b) => b.weight - a.weight);
}

export function renderUsage(ctx: ViewContext, width: number, height: number, range: UsageRange, metric: UsageMetric): string[] {
	const lines = [titleBar(ctx, width, "usage")];
	const open = openLabels(ctx);

	const quotaGauge = width >= 120 ? 22 : 12;
	const providerWidth = Math.max(0, ...ctx.quota.windows.map((window) => visibleWidth(window.providerLabel))) + 1;
	if (ctx.quota.windows.length) {
		lines.push(fit(theme.dim(`${field("QUOTA")}${" ".repeat(providerWidth + 4)}${fit("used", quotaGauge + 7)}${fit("resets", 9)}share by session (est.)`), width));
	} else {
		lines.push(fit(`${field("QUOTA")}${theme.dim("no subscription quota data (provider-failover-state.json not found)")}`, width));
	}
	let previous: string | undefined;
	for (const window of ctx.quota.windows) {
		const since = Math.max(window.resetAt - window.windowSeconds * 1000, ctx.now - window.windowSeconds * 1000);
		const shares = quotaShares(ctx.usage.byOwner(since, window.provider));
		const top = shares.slice(0, 4);
		const rest = shares.slice(4).reduce((sum, share) => sum + share.weight, 0);
		const parts = top.map((share, index) => ({ value: share.weight, paint: PALETTE[index] }));
		if (rest > 0) parts.push({ value: rest, paint: theme.dim });
		const exhausted = window.exhaustedUntil && window.exhaustedUntil > ctx.now ? theme.error(`exhausted ${fmtDuration(window.exhaustedUntil - ctx.now)}  `) : "";
		const reset = window.resetAt > ctx.now ? theme.dim(`↻ ${fmtDuration(window.resetAt - ctx.now)}`) : "";
		const provider = window.provider !== previous ? theme.text(window.providerLabel) : "";
		previous = window.provider;
		const percent = levelColor(window.usedPercent / 100)(fitRight(`${Math.round(window.usedPercent)}%`, 4));
		const head = `${fit(provider, providerWidth)}${fit(theme.muted(window.label), 4)}${gauge(window.usedPercent / 100, quotaGauge)} ${percent}  ${fit(reset, 9)}`;
		// Exhaustion goes before the share estimate so narrow terminals still show it.
		const start = `${" ".repeat(8)}${head}${exhausted}${shareBar(parts, 16)}  `;
		const labelWidth = Math.max(MIN_LEGEND_LABEL, Math.floor((width - visibleWidth(start)) / Math.max(1, top.length)) - 2);
		const legend = top.map((share, index) => clip(ownerLabel(open, share.owner, share.file, PALETTE[index]), labelWidth)).join("  ");
		lines.push(fit(start + legend, width));
	}

	const since = rangeStart(range, ctx.now);
	const total = ctx.usage.total(since);
	const chips = <T extends string>(options: readonly T[], active: T, label: (option: T) => string) =>
		options.map((option) => (option === active ? theme.chip(theme.bold(theme.text(` ${label(option)} `))) : theme.dim(` ${label(option)} `))).join("");
	const selector = `${chips(USAGE_RANGES, range, (option) => option)}  ${chips(USAGE_METRICS, metric, (option) => (option === "cost" ? "$" : "tokens"))}`;
	const cacheHit = total.prompt > 0 ? total.cacheRead / total.prompt : 0;
	const status = ctx.usage.scanned ? "" : theme.waiting(`   indexing session files… (${ctx.usage.files.size} so far)`);
	lines.push("", rule(width, `${selector}   ${theme.bold(theme.text(`$${fmtCost(total.cost)}`))} ${theme.dim(`· ${fmtTokens(total.tokens)} tokens · cache hit ${Math.round(cacheHit * 100)}%`)}${status}`), "");

	const leftWidth = Math.floor((width - 3) / 2);
	const rightWidth = width - 3 - leftWidth;
	const noun = metric === "cost" ? "COST" : "TOKENS";
	const left: string[] = [`${theme.muted(`${noun} BY SESSION`)}   ${theme.accent("■")}${theme.dim(" open")}`];
	// Sessions below half a cent round to nothing in cost; any token counts.
	const owners = [...ctx.usage.byOwner(since).entries()].filter(([, entry]) => (metric === "cost" ? entry.usage.cost >= 0.005 : entry.usage.tokens > 0)).sort((a, b) => b[1].usage[metric] - a[1].usage[metric]);
	const maxOwner = owners[0]?.[1].usage[metric] ?? 0;
	const listed = Math.max(1, height - lines.length - 4);
	const nameWidth = Math.max(14, Math.floor(leftWidth * 0.45));
	for (const [owner, entry] of owners.slice(0, listed)) {
		const live = open.has(owner);
		const value = entry.usage[metric];
		left.push(`${fit(ownerLabel(open, owner, entry.file), nameWidth)} ${hbar(value, maxOwner, Math.max(4, leftWidth - nameWidth - 10), live ? theme.accent : theme.faint)} ${fitRight(theme.text(metric === "cost" ? fmtCost(value) : fmtTokens(value)), 7)}`);
	}
	if (!owners.length) left.push(theme.dim(ctx.usage.scanned ? "no usage in range" : "…"));

	const bucketHours = range === "today" ? 1 : range === "7d" ? 6 : 24;
	const chartWidth = Math.max(8, rightWidth - 8);
	// The buckets cover the whole range, so they fill the chart from its start label to "now".
	const series = stretch(ctx.usage.series(since, ctx.now, bucketHours, metric), chartWidth);
	const maxBucket = Math.max(1e-9, ...series);
	const right: string[] = [`${theme.muted(`${noun} per ${bucketHours === 1 ? "hour" : bucketHours === 6 ? "6h" : "day"}`)}`];
	stackedArea(series, series.map(() => 0), chartWidth, CHART_HEIGHT, maxBucket).forEach((row, index) => {
		const axis = index === 0 ? amount(metric, maxBucket) : index === CHART_HEIGHT - 1 ? "0" : "";
		right.push(`${theme.dim(fitRight(axis, 7))}${theme.faint(axis ? "┤" : "│")}${row}`);
	});
	right.push(theme.dim(`${" ".repeat(8)}${fit(range === "today" ? "00:00" : range, Math.floor(chartWidth / 2))}${fitRight("now", Math.ceil(chartWidth / 2))}`));
	right.push("", theme.muted("BY MODEL"));
	// One model reached through several accounts (e.g. codex and codex#2) is one model here.
	const models = new Map<string, number>();
	for (const [model, usage] of ctx.usage.byModel(since)) {
		const name = model.split("/").pop() ?? model;
		models.set(name, (models.get(name) ?? 0) + usage[metric]);
	}
	const totalValue = total[metric];
	for (const [model, value] of [...models.entries()].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
		const share = totalValue > 0 ? value / totalValue : 0;
		right.push(`${fit(theme.text(model), 18)} ${hbar(share, 1, Math.max(4, rightWidth - 34))} ${fitRight(theme.text(`${Math.round(share * 100)}%`), 4)} ${fitRight(theme.dim(amount(metric, value)), 8)}`);
	}

	const count = Math.max(left.length, right.length);
	for (let index = 0; index < count; index++) lines.push(`${fit(left[index] ?? "", leftWidth)} ${theme.faint("│")} ${fit(right[index] ?? "", rightWidth)}`);
	lines.push("", fit(theme.dim(" $ is pi's API-equivalent cost; unpriced models count in tokens only. Subagents count toward the session that spawned them. 30 days kept."), width));
	const free = height - 1 - lines.length;
	for (let index = 0; index < free; index++) lines.push("");
	return lines.slice(0, height - 1);
}
