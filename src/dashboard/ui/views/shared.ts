import { visibleWidth } from "@earendil-works/pi-tui";
import type { GpuMonitor } from "../../collectors/gpu.ts";
import type { QuotaMonitor, QuotaWindow } from "../../collectors/quota.ts";
import { rowLabel, type SessionRow, type Store } from "../../model/store.ts";
import type { UsageIndex } from "../../usage/usage-index.ts";
import { gauge, planBar, sparkline } from "../charts.ts";
import { fit, fitRight, fmtBytes, fmtCost, fmtDuration, oneLine } from "../format.ts";
import { type Paint, theme } from "../theme.ts";

export interface ViewContext {
	store: Store;
	usage: UsageIndex;
	quota: QuotaMonitor;
	gpu: GpuMonitor;
	now: number;
	/** Current spinner frame for working sessions. */
	spinner: string;
	selected?: SessionRow;
}

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const DAY_MS = 86_400_000;

/** Pad a styled line to `width` and paint a background across it. */
export function background(line: string, width: number, paint: Paint): string {
	return paint(fit(line, width));
}

export function sessionCost(row: SessionRow, usage: UsageIndex): { direct: number; indirect: number; subagents: number; total: number } {
	const direct = row.bridge?.usage.direct.cost ?? 0;
	const indirect = row.bridge?.usage.indirect.cost ?? 0;
	const subagents = row.bridge ? usage.subagentUsage(row.bridge.sessionId).cost : 0;
	return { direct, indirect, subagents, total: direct + indirect + subagents };
}

export function startOfToday(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export function titleBar(ctx: ViewContext, width: number, title: string): string {
	const rows = ctx.store.ordered();
	const working = rows.filter((row) => row.status.kind === "working" || row.status.kind === "rate-limited" || row.status.kind === "stalled").length;
	const waiting = rows.filter((row) => row.status.kind === "needs-you").length;
	const errors = rows.filter((row) => row.status.kind === "error").length;
	const counts = [
		working ? theme.working(`${ctx.spinner} ${working} working`) : "",
		waiting ? theme.waiting(`◆ ${waiting} needs you`) : "",
		errors ? theme.error(`✖ ${errors} error`) : "",
	]
		.filter(Boolean)
		.join("  ");
	const clock = new Date(ctx.now).toTimeString().slice(0, 5);
	const left = ` ${theme.bold(theme.accent("pi-dash"))} ${theme.muted(title)}`;
	const right = `${counts}  ${theme.muted(clock)} `;
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return background(left + " ".repeat(gap) + right, width, theme.bar);
}

function quotaWindowText(window: QuotaWindow, now: number, gaugeWidth: number, withProvider: boolean): string {
	const exhausted = window.exhaustedUntil && window.exhaustedUntil > now;
	const head = withProvider ? `${theme.text(window.providerLabel)} ` : "";
	const reset = window.resetAt > now ? theme.dim(` ↻${fmtDuration(window.resetAt - now)}`) : "";
	const tail = exhausted ? theme.error(` exhausted ${fmtDuration((window.exhaustedUntil ?? now) - now)}`) : reset;
	return `${head}${theme.muted(window.label)} ${gauge(window.usedPercent / 100, gaugeWidth)}${String(Math.round(window.usedPercent)).padStart(3)}%${tail}`;
}

export function quotaLine(ctx: ViewContext, width: number): string | undefined {
	const windows = ctx.quota.windows;
	if (!windows.length) return undefined;
	// The most-used windows matter most; on narrow terminals they are shown first.
	const ordered = width >= 120 ? windows : [...windows].sort((a, b) => b.usedPercent - a.usedPercent);
	let line = "";
	// Shrink gauges until every window fits on one line.
	for (const gaugeWidth of [12, 10, 8, 6, 4]) {
		const parts: string[] = [];
		let previous: string | undefined;
		for (const window of ordered) {
			parts.push(quotaWindowText(window, ctx.now, gaugeWidth, window.provider !== previous));
			previous = window.provider;
		}
		line = ` ${theme.dim("QUOTA")} ${parts.join("  ")}`;
		if (visibleWidth(line) <= width) break;
	}
	return fit(line, width);
}

export function hostLine(ctx: ViewContext, width: number): string {
	const host = ctx.store.host;
	const spark = width >= 120 ? 12 : width >= 100 ? 6 : 0;
	const trend = (values: number[]) => (spark ? `${sparkline(values, spark, 1)} ` : "");
	const parts = [theme.dim("HOST")];
	const today = ctx.usage.total(startOfToday(ctx.now));
	const hourly = ctx.usage.series(startOfToday(ctx.now), ctx.now, 1, "cost");
	const todayText = ctx.usage.scanned || ctx.usage.files.size ? `today ${theme.text(`$${fmtCost(today.cost)}`)}${spark ? ` ${sparkline(hourly, Math.min(12, Math.max(1, hourly.length)))}` : ""}` : theme.dim("today …");
	parts.push(`cpu ${trend(ctx.store.hostCpu.last(spark * 15))}${String(Math.round((host?.cpu ?? 0) * 100)).padStart(3)}%`);
	if (host) parts.push(`mem ${gauge(host.memUsed / Math.max(1, host.memTotal), width >= 120 ? 12 : 8)}${fmtBytes(host.memUsed)}/${fmtBytes(host.memTotal)}`);
	const gpu = ctx.store.gpu;
	if (gpu && ctx.gpu.available) parts.push(`gpu ${trend(ctx.store.gpuUtil.last(spark * 15))}${String(Math.round(gpu.utilization * 100)).padStart(3)}%${spark ? ` ${fmtBytes(gpu.memUsed)}/${fmtBytes(gpu.memTotal)}` : ""}`);
	parts.push(todayText);
	return fit(` ${parts.join(width >= 100 ? "   " : "  ")}`, width);
}

export function rule(width: number, label = ""): string {
	if (!label) return theme.dim("─".repeat(width));
	const text = fit(` ${label}`, Math.min(width - 2, visibleWidth(label) + 2));
	return fit(theme.dim("─") + text + theme.dim("─".repeat(Math.max(0, width - 1 - visibleWidth(text)))), width);
}

const ACTIVITY_ICON: Record<string, string> = { tool: "⚙", thinking: "✎", writing: "✎", compacting: "⟳", continuing: "⟳", model: "…" };

export function statusCell(row: SessionRow, ctx: ViewContext): string {
	const status = row.status;
	const timer = status.since !== undefined ? theme.dim(` ${fmtDuration(ctx.now - status.since)}`) : "";
	if (row.incompatibleVersion !== undefined) return theme.error(`✖ bridge v${row.incompatibleVersion}`);
	switch (status.kind) {
		case "working": {
			const icon = ACTIVITY_ICON[row.bridge?.activity?.kind ?? "model"] ?? "…";
			return `${theme.working(ctx.spinner)} ${theme.working(icon)} ${theme.text(status.label)}${timer}`;
		}
		case "rate-limited":
			return `${theme.error("✖ 429")} ${theme.text("retrying")}${timer}`;
		case "stalled":
			return `${theme.waiting("◆?")} ${theme.waiting("stalled")}${timer}`;
		case "needs-you":
			return `${theme.waiting("◆ needs you")}${timer}`;
		case "ready":
			return theme.dim("○ ready");
		case "error":
			return theme.error(`✖ ${oneLine(status.label)}`);
		case "connecting":
			return theme.dim("… reconnecting");
		case "exited":
			return theme.dim(`◌ exited${status.since !== undefined ? ` ${fmtDuration(ctx.now - status.since)}` : ""}`);
		case "unbridged":
			return theme.dim("? no bridge");
	}
}

export function planCell(row: SessionRow, width: number): string {
	const plan = row.bridge?.plan;
	if (plan) {
		const done = plan.total > 0 && plan.complete >= plan.total;
		const leaf = done ? "done" : (plan.activePath.at(-1)?.title ?? plan.title);
		return fit(`${planBar(plan.complete, plan.total, 6)} ${theme.muted(`${plan.complete}/${plan.total}`)} ${theme.text(leaf)}`, width);
	}
	if (row.bridge?.lastPrompt) return fit(theme.dim(`"${row.bridge.lastPrompt}"`), width);
	return fit(theme.dim("—"), width);
}

export function minuteSeries(row: SessionRow, minutes: number, now: number, metric: "tokens" | "cost" = "tokens"): number[] {
	const values = new Array<number>(minutes).fill(0);
	const current = Math.floor(now / 60_000);
	for (const bucket of row.bridge?.usageMinutes ?? []) {
		const index = minutes - 1 - (current - bucket.minute);
		if (index >= 0 && index < minutes) values[index] += bucket[metric];
	}
	return values;
}

export function cpuSeries(row: SessionRow, samples: number): number[] {
	const direct = row.cpuDirect.last(samples);
	const indirect = row.cpuIndirect.last(samples);
	return direct.map((value, index) => value + indirect[index]);
}

export function rowName(row: SessionRow, width: number, selected: boolean): string {
	const label = rowLabel(row);
	return fit(selected ? theme.bold(theme.text(label)) : theme.text(label), width);
}

export function costText(dollars: number, width: number): string {
	return fitRight(dollars > 0 ? theme.text(fmtCost(dollars)) : theme.dim("—"), width);
}

export function laneLegend(): string {
	return `${theme.working("█")}${theme.dim(" working ")} ${theme.waiting("▒")}${theme.dim(" waiting on you ")} ${theme.dim("░ idle")}`;
}


export function weekAgo(now: number): number {
	return now - 7 * DAY_MS;
}

export function monthAgo(now: number): number {
	return now - 30 * DAY_MS;
}
