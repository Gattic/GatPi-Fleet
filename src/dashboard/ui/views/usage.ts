import { basename } from "node:path";
import { rowLabel } from "../../model/store.ts";
import { gauge, hbar, shareBar, stackedArea, stretch } from "../charts.ts";
import { fit, fitRight, fmtCost, fmtDuration, fmtTokens } from "../format.ts";
import { levelColor, type Paint, theme } from "../theme.ts";
import { field, monthAgo, rule, startOfToday, titleBar, type ViewContext, weekAgo } from "./shared.ts";

export type UsageRange = "today" | "7d" | "30d";
export const USAGE_RANGES: UsageRange[] = ["today", "7d", "30d"];

const PALETTE: Paint[] = [theme.accent, theme.working, theme.waiting, theme.indirect, theme.error, theme.muted];
const CHART_HEIGHT = 6;

function rangeStart(range: UsageRange, now: number): number {
	if (range === "today") return startOfToday(now);
	return range === "7d" ? weekAgo(now) : monthAgo(now);
}

function ownerLabels(ctx: ViewContext): Map<string, string> {
	const labels = new Map<string, string>();
	for (const row of ctx.store.rows.values()) if (row.bridge) labels.set(row.bridge.sessionId, rowLabel(row));
	return labels;
}

export function renderUsage(ctx: ViewContext, width: number, height: number, range: UsageRange): string[] {
	const lines = [titleBar(ctx, width, "usage")];
	const labels = ownerLabels(ctx);
	const labelFor = (owner: string, file: { name?: string; cwd?: string }) => labels.get(owner) ?? file.name ?? (file.cwd ? basename(file.cwd) : "unknown");

	const quotaGauge = width >= 120 ? 22 : 12;
	if (ctx.quota.windows.length) {
		lines.push(fit(theme.dim(`${field("QUOTA")}${" ".repeat(13)}${fit("used", quotaGauge + 7)}${fit("resets", 9)}share by session (est.)`), width));
	} else {
		lines.push(fit(`${field("QUOTA")}${theme.dim("no subscription quota data (provider-failover-state.json not found)")}`, width));
	}
	let previous: string | undefined;
	for (const window of ctx.quota.windows) {
		const since = Math.max(window.resetAt - window.windowSeconds * 1000, ctx.now - window.windowSeconds * 1000);
		const owners = [...ctx.usage.byOwner(since, window.provider).entries()].sort((a, b) => b[1].usage.cost - a[1].usage.cost);
		const top = owners.slice(0, 4);
		const rest = owners.slice(4).reduce((sum, [, entry]) => sum + entry.usage.cost, 0);
		const parts = top.map(([, entry], index) => ({ value: entry.usage.cost, paint: PALETTE[index] }));
		if (rest > 0) parts.push({ value: rest, paint: theme.dim });
		const legend = top.map(([owner, entry], index) => PALETTE[index](labelFor(owner, entry.file))).join("  ");
		const exhausted = window.exhaustedUntil && window.exhaustedUntil > ctx.now ? theme.error(`exhausted ${fmtDuration(window.exhaustedUntil - ctx.now)}  `) : "";
		const reset = window.resetAt > ctx.now ? theme.dim(`↻ ${fmtDuration(window.resetAt - ctx.now)}`) : "";
		const provider = window.provider !== previous ? theme.text(window.providerLabel) : "";
		previous = window.provider;
		const percent = levelColor(window.usedPercent / 100)(fitRight(`${Math.round(window.usedPercent)}%`, 4));
		const head = `${fit(provider, 9)}${fit(theme.muted(window.label), 4)}${gauge(window.usedPercent / 100, quotaGauge)} ${percent}  ${fit(reset, 9)}`;
		// Exhaustion goes before the share estimate so narrow terminals still show it.
		lines.push(fit(`${" ".repeat(8)}${head}${exhausted}${shareBar(parts, 16)}  ${legend}`, width));
	}

	const since = rangeStart(range, ctx.now);
	const total = ctx.usage.total(since);
	const selector = USAGE_RANGES.map((option) => (option === range ? theme.chip(theme.bold(theme.text(` ${option} `))) : theme.dim(` ${option} `))).join("");
	const cacheHit = total.prompt > 0 ? total.cacheRead / total.prompt : 0;
	const status = ctx.usage.scanned ? "" : theme.waiting(`   indexing session files… (${ctx.usage.files.size} so far)`);
	lines.push("", rule(width, `${selector}   ${theme.bold(theme.text(`$${fmtCost(total.cost)}`))} ${theme.dim(`· ${fmtTokens(total.tokens)} tokens · cache hit ${Math.round(cacheHit * 100)}%`)}${status}`), "");

	const leftWidth = Math.floor((width - 3) / 2);
	const rightWidth = width - 3 - leftWidth;
	const left: string[] = [`${theme.muted("COST BY SESSION")}   ${theme.accent("■")}${theme.dim(" open")}`];
	const owners = [...ctx.usage.byOwner(since).entries()].filter(([, entry]) => entry.usage.cost >= 0.005).sort((a, b) => b[1].usage.cost - a[1].usage.cost);
	const maxCost = owners[0]?.[1].usage.cost ?? 0;
	const listed = Math.max(1, height - lines.length - 4);
	const nameWidth = Math.max(14, Math.floor(leftWidth * 0.45));
	for (const [owner, entry] of owners.slice(0, listed)) {
		const live = labels.has(owner);
		const project = entry.file.cwd ? basename(entry.file.cwd) : "";
		const title = entry.file.name ?? entry.file.firstPrompt;
		const name = live ? theme.text(labels.get(owner) ?? "") : `${theme.muted(project)}${title ? theme.dim(` › ${title}`) : ""}`;
		left.push(`${fit(name, nameWidth)} ${hbar(entry.usage.cost, maxCost, Math.max(4, leftWidth - nameWidth - 10), live ? theme.accent : theme.faint)} ${fitRight(theme.text(fmtCost(entry.usage.cost)), 7)}`);
	}
	if (!owners.length) left.push(theme.dim(ctx.usage.scanned ? "no usage in range" : "…"));

	const bucketHours = range === "today" ? 1 : range === "7d" ? 6 : 24;
	const chartWidth = Math.max(8, rightWidth - 8);
	// The buckets cover the whole range, so they fill the chart from its start label to "now".
	const series = stretch(ctx.usage.series(since, ctx.now, bucketHours, "cost"), chartWidth);
	const maxBucket = Math.max(1e-9, ...series);
	const right: string[] = [`${theme.muted(`COST per ${bucketHours === 1 ? "hour" : bucketHours === 6 ? "6h" : "day"}`)}`];
	stackedArea(series, series.map(() => 0), chartWidth, CHART_HEIGHT, maxBucket).forEach((row, index) => {
		const axis = index === 0 ? `$${fmtCost(maxBucket)}` : index === CHART_HEIGHT - 1 ? "0" : "";
		right.push(`${theme.dim(fitRight(axis, 7))}${theme.faint(axis ? "┤" : "│")}${row}`);
	});
	right.push(theme.dim(`${" ".repeat(8)}${fit(range === "today" ? "00:00" : range, Math.floor(chartWidth / 2))}${fitRight("now", Math.ceil(chartWidth / 2))}`));
	right.push("", theme.muted("BY MODEL"));
	const models = [...ctx.usage.byModel(since).entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
	for (const [model, usage] of models) {
		const share = total.cost > 0 ? usage.cost / total.cost : 0;
		right.push(`${fit(theme.text(model.split("/").pop() ?? model), 18)} ${hbar(share, 1, Math.max(4, rightWidth - 34))} ${fitRight(theme.text(`${Math.round(share * 100)}%`), 4)} ${fitRight(theme.dim(`$${fmtCost(usage.cost)}`), 8)}`);
	}

	const count = Math.max(left.length, right.length);
	for (let index = 0; index < count; index++) lines.push(`${fit(left[index] ?? "", leftWidth)} ${theme.faint("│")} ${fit(right[index] ?? "", rightWidth)}`);
	lines.push("", fit(theme.dim(" $ is pi's API-equivalent cost. Subagent usage counts toward the session that spawned it. The index keeps 30 days."), width));
	const free = height - 1 - lines.length;
	for (let index = 0; index < free; index++) lines.push("");
	return lines.slice(0, height - 1);
}
