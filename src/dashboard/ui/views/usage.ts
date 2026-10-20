import { truncateToWidth } from "@earendil-works/pi-tui";
import { rowLabel } from "../../../manager/model/store.ts";
import { bucketHours, cacheHit, hostUsage, indexing, rangeStart, rankedModels, rankedOwners, sessionTitle, USAGE_METRICS, USAGE_RANGES, type UsageMetric, type UsageRange } from "../../../manager/usage/report.ts";
import type { FileUsage } from "../../../manager/usage/types.ts";
import { ownerKey } from "../../../manager/usage/usage-index.ts";
import { hbar, stackedArea, stretch } from "../charts.ts";
import { ELLIPSIS, fit, fitRight, fmtCost, fmtTokens } from "../format.ts";
import { theme } from "../theme.ts";
import { cooldownLine, quotaLines, rule, titleBar, type ViewContext } from "./shared.ts";

const CHART_HEIGHT = 6;

/** Open sessions by slot and row label. */
function openLabels(ctx: ViewContext): Map<string, string> {
	const labels = new Map<string, string>();
	for (const row of ctx.store.rows.values()) if (row.bridge) labels.set(ownerKey(row.host, row.bridge.sessionId), `${row.slot ?? "·"} ${rowLabel(row)}`);
	return labels;
}

/** An open session by its row label; an ended one by project and name (or first prompt), so sessions of one project stay apart. */
function ownerLabel(open: Map<string, string>, owner: string, file: FileUsage): string {
	const label = open.get(owner);
	if (label) return theme.text(label);
	const { project, title } = sessionTitle(file);
	return `${theme.muted(project)}${title ? theme.dim(` › ${title}`) : ""}`;
}

function amount(metric: UsageMetric, value: number): string {
	return metric === "cost" ? `$${fmtCost(value)}` : fmtTokens(value);
}

/** A machine's name, marked while its usage is incomplete: still being indexed, not connected yet, or offline (what it reported before stays counted). A long name is shortened, never its mark. */
function hostName(ctx: ViewContext, host: string | undefined): string {
	if (host === undefined) return theme.text("this machine");
	const name = truncateToWidth(host, 15, ELLIPSIS);
	switch (ctx.remotes.get(host)!.status.kind) {
		case "online":
			return `${theme.text(name)}${ctx.usage.hostScanned(host) ? "" : theme.waiting(" …")}`;
		case "offline":
			return `${theme.muted(name)}${theme.error(" ✖")}`;
		case "connecting":
			return `${theme.muted(name)}${theme.dim(" …")}`;
	}
}

export function renderUsage(ctx: ViewContext, width: number, height: number, range: UsageRange, metric: UsageMetric): string[] {
	const lines = [titleBar(ctx, width, "usage")];
	const open = openLabels(ctx);

	lines.push(...quotaLines(ctx, width), cooldownLine(ctx, width));

	const since = rangeStart(range, ctx.now);
	const total = ctx.usage.total(since);
	const chips = <T extends string>(options: readonly T[], active: T, label: (option: T) => string) =>
		options.map((option) => (option === active ? theme.chip(theme.bold(theme.text(` ${label(option)} `))) : theme.dim(` ${label(option)} `))).join("");
	const selector = `${chips(USAGE_RANGES, range, (option) => option)}  ${chips(USAGE_METRICS, metric, (option) => (option === "cost" ? "$" : "tokens"))}`;
	const status = indexing(ctx.usage, ctx.remotes.values()) ? theme.waiting(`   indexing session files… (${ctx.usage.files.size} so far)`) : "";
	lines.push("", rule(width, `${selector}   ${theme.bold(theme.text(`$${fmtCost(total.cost)}`))} ${theme.dim(`· ${fmtTokens(total.tokens)} tokens · cache hit ${Math.round(cacheHit(total) * 100)}%`)}${status}`), "");

	const leftWidth = Math.floor((width - 3) / 2);
	const rightWidth = width - 3 - leftWidth;
	const noun = metric === "cost" ? "COST" : "TOKENS";
	const left: string[] = [`${theme.muted(`${noun} BY SESSION`)}   ${theme.accent("■")}${theme.dim(" open")}`];
	const owners = rankedOwners(ctx.usage, since, metric);
	const maxOwner = owners[0]?.usage[metric] ?? 0;
	// What follows the columns: a blank line and the notes. The columns take the rows between, so the notes stay in view.
	const footer = ctx.remotes.size ? 3 : 2;
	const rows = Math.max(2, height - 1 - lines.length - footer);
	const listed = rows - 1;
	const nameWidth = Math.max(14, Math.floor(leftWidth * 0.45));
	for (const { owner, file, usage } of owners.slice(0, listed)) {
		const live = open.has(owner);
		const value = usage[metric];
		left.push(`${fit(ownerLabel(open, owner, file), nameWidth)} ${hbar(value, maxOwner, Math.max(4, leftWidth - nameWidth - 10), live ? theme.accent : theme.faint)} ${fitRight(theme.text(metric === "cost" ? fmtCost(value) : fmtTokens(value)), 7)}`);
	}
	if (!owners.length) left.push(theme.dim(ctx.usage.scanned ? "no usage in range" : "…"));

	const hours = bucketHours(range);
	const chartWidth = Math.max(8, rightWidth - 8);
	// The buckets cover the whole range, so they fill the chart from its start label to "now".
	const series = stretch(ctx.usage.series(since, ctx.now, hours, metric), chartWidth);
	const maxBucket = Math.max(1e-9, ...series);
	const right: string[] = [`${theme.muted(`${noun} per ${hours === 1 ? "hour" : hours === 6 ? "6h" : "day"}`)}`];
	stackedArea(series, series.map(() => 0), chartWidth, CHART_HEIGHT, maxBucket).forEach((row, index) => {
		const axis = index === 0 ? amount(metric, maxBucket) : index === CHART_HEIGHT - 1 ? "0" : "";
		right.push(`${theme.dim(fitRight(axis, 7))}${theme.faint(axis ? "┤" : "│")}${row}`);
	});
	right.push(theme.dim(`${" ".repeat(8)}${fit(range === "today" ? "00:00" : range, Math.floor(chartWidth / 2))}${fitRight("now", Math.ceil(chartWidth / 2))}`));
	const totalValue = total[metric];
	const shareRow = (name: string, value: number) => {
		const share = totalValue > 0 ? value / totalValue : 0;
		return `${fit(name, 18)} ${hbar(share, 1, Math.max(4, rightWidth - 34))} ${fitRight(theme.text(`${Math.round(share * 100)}%`), 4)} ${fitRight(theme.dim(amount(metric, value)), 8)}`;
	};
	if (ctx.remotes.size) {
		right.push("", theme.muted("BY HOST"));
		for (const { host, value } of hostUsage(ctx.usage, since, metric, [...ctx.remotes.keys()])) right.push(shareRow(hostName(ctx, host), value));
	}
	right.push("", theme.muted("BY MODEL"));
	for (const { model, value } of rankedModels(ctx.usage, since, metric).slice(0, 5)) right.push(shareRow(theme.text(model), value));

	const count = Math.min(Math.max(left.length, right.length), rows);
	for (let index = 0; index < count; index++) lines.push(`${fit(left[index] ?? "", leftWidth)} ${theme.faint("│")} ${fit(right[index] ?? "", rightWidth)}`);
	lines.push("", fit(theme.dim(" $ is pi's API-equivalent cost; unpriced models count in tokens only. Subagents count toward the session that spawned them. 30 days kept."), width));
	if (ctx.remotes.size) lines.push(fit(theme.dim(" Hosts: … still indexing or connecting; ✖ offline, what it reported before stays counted."), width));
	const free = height - 1 - lines.length;
	for (let index = 0; index < free; index++) lines.push("");
	return lines.slice(0, height - 1);
}
