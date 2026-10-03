import { visibleWidth } from "@earendil-works/pi-tui";
import { rowCwd, rowLabel, rowSty, type SessionRow } from "../../model/store.ts";
import { activityLane, downsample, gauge, planBar, sparkline, splitBar } from "../charts.ts";
import { fit, fitRight, fmtBytes, fmtCores, fmtDuration, oneLine, shortPath } from "../format.ts";
import { TextPane } from "../text-pane.ts";
import { levelColor, theme } from "../theme.ts";
import {
	background,
	backgroundBadge,
	backgroundLine,
	cpuSeries,
	field,
	hostLine,
	laneLegend,
	MIN_CPU_SCALE,
	MIN_MEM_SCALE,
	minuteSeries,
	planCell,
	quotaLine,
	rowName,
	rule,
	saidPane,
	sessionUsage,
	spendText,
	statusCell,
	titleBar,
	type ViewContext,
} from "./shared.ts";

/** Samples behind the per-row CPU sparkline (2 minutes at 2 s). */
const CPU_SPARK_SAMPLES = 60;
const CPU_SPARK_WIDTH = 5;
const API_SPARK_MINUTES = 12;
const API_SPARK_WIDTH = 6;
/** The selected session's latest reply, previewed in the rows the table leaves free. */
const preview = new TextPane();

/** One scale per column across all rows, so rows can be compared. */
interface Scales {
	cpu: number;
	mem: number;
	api: number;
}

function cpuColumns(row: SessionRow): number[] {
	return downsample(cpuSeries(row, CPU_SPARK_SAMPLES), CPU_SPARK_WIDTH);
}

function apiColumns(row: SessionRow, now: number): number[] {
	return downsample(minuteSeries(row, API_SPARK_MINUTES, now), API_SPARK_WIDTH);
}

function peak(values: readonly number[]): number {
	return Math.max(0, ...values.filter((value) => !Number.isNaN(value)));
}

function scales(rows: readonly SessionRow[], now: number): Scales {
	const live = rows.filter((row) => row.exitedAt === undefined);
	return {
		cpu: Math.max(MIN_CPU_SCALE, ...live.map((row) => peak(cpuColumns(row)))),
		mem: Math.max(MIN_MEM_SCALE, ...live.map((row) => (row.resources ? row.resources.directMem + row.resources.indirectMem : 0))),
		api: Math.max(0, ...rows.filter((row) => row.bridge).map((row) => peak(apiColumns(row, now)))),
	};
}

interface Columns {
	name: number;
	state: number;
	plan: number;
	ctx: number;
	cpu: number;
	mem: number;
	api: number;
	bg: number;
	cost: number;
}

function columns(width: number, rows: readonly SessionRow[]): Columns {
	const full = width >= 100;
	const wide = width >= 120;
	// Background work is also listed under the table, so its column only shows when PLAN keeps its room.
	const widest = width >= 140;
	// Names get the room they need, up to a cap; the plan column takes the rest.
	const longest = Math.max(0, ...rows.map((row) => visibleWidth(rowLabel(row))));
	const name = Math.max(10, Math.min(wide ? 20 : full ? 14 : 12, longest));
	const fixed = { name, state: wide ? 24 : full ? 22 : 18, ctx: 4, cpu: 11, mem: full ? 13 : 0, api: full ? 7 : 0, bg: widest ? 5 : 0, cost: 6 };
	const separators = widest ? 10 : full ? 9 : 7;
	const plan = Math.max(8, width - 2 - separators - fixed.name - fixed.state - fixed.ctx - fixed.cpu - fixed.mem - fixed.api - fixed.bg - fixed.cost);
	return { ...fixed, plan };
}

function headerRow(cols: Columns, width: number): string {
	const parts = ["  ", fit("SESSION", cols.name), fit("STATE", cols.state), fit("PLAN", cols.plan), fitRight("CTX", cols.ctx), fit("CPU", cols.cpu)];
	if (cols.mem) parts.push(fit(`MEM ${theme.direct("▓")}${theme.indirect("▒")}`, cols.mem));
	if (cols.api) parts.push(fit("API/m", cols.api));
	if (cols.bg) parts.push(fit("BG", cols.bg));
	parts.push(fitRight("$", cols.cost));
	return fit(theme.dim(parts.join(" ")), width);
}

function sessionRow(row: SessionRow, ctx: ViewContext, cols: Columns, width: number, scale: Scales): string {
	const selected = ctx.selected === row;
	const marker = selected ? theme.accent("▌") : " ";
	const slot = row.slot !== undefined ? (selected ? theme.bold(theme.accent(String(row.slot))) : theme.muted(String(row.slot))) : theme.dim("·");
	const live = row.exitedAt === undefined;
	const resources = row.resources;
	const cpuText = live && resources ? `${sparkline(cpuColumns(row), CPU_SPARK_WIDTH, scale.cpu, theme.working)} ${theme.text(fitRight(fmtCores(resources.directCpu + resources.indirectCpu), 5))}` : "";
	const percent = live ? row.bridge?.context?.percent : undefined;
	const ctxText = percent != null ? levelColor(percent / 100)(`${Math.round(percent)}%`) : "";
	const parts = [marker + slot, rowName(row, cols.name, selected), fit(statusCell(row, ctx), cols.state), planCell(row, cols.plan), fitRight(ctxText, cols.ctx), fit(cpuText, cols.cpu)];
	if (cols.mem) {
		const memText = live && resources ? `${splitBar(resources.directMem, resources.indirectMem, scale.mem, 7)} ${theme.text(fitRight(fmtBytes(resources.directMem + resources.indirectMem), 5))}` : "";
		parts.push(fit(memText, cols.mem));
	}
	if (cols.api) parts.push(fit(row.bridge ? sparkline(apiColumns(row, ctx.now), API_SPARK_WIDTH, scale.api, theme.indirect) : "", cols.api));
	if (cols.bg) parts.push(fit(backgroundBadge(row), cols.bg));
	parts.push(row.bridge ? spendText(sessionUsage(row, ctx.usage).total, cols.cost) : fitRight(theme.dim("—"), cols.cost));
	const line = parts.join(" ");
	if (row.alertUntil !== undefined) return background(line, width, theme.alert);
	return selected ? background(line, width, theme.selected) : fit(line, width);
}

/** The selected session: identity, plan, current activity, the last hour, the last prompt, its latest reply in the remaining rows, and the suggested next prompt. */
function selectedSummary(row: SessionRow, ctx: ViewContext, width: number, maxLines: number): string[] {
	const bridge = row.bridge;
	const lines: string[] = [];
	const cwd = rowCwd(row);
	const sty = rowSty(row);
	const head = [
		theme.bold(theme.text(`${row.slot ?? "·"} ${rowLabel(row)}`)),
		cwd ? theme.muted(shortPath(cwd)) : "",
		bridge?.model ? theme.muted(`${bridge.model.split("/").pop()}${bridge.thinking ? ` · ${bridge.thinking}` : ""}`) : "",
		bridge?.context?.percent != null ? `${theme.muted("ctx")} ${gauge(bridge.context.percent / 100, 10)} ${theme.muted(`${Math.round(bridge.context.percent)}%`)}` : "",
		sty ? theme.dim(`screen ${sty}`) : "",
	].filter(Boolean);
	lines.push(rule(width, head.join(theme.dim(" · "))));

	if (bridge?.plan) {
		const plan = bridge.plan;
		const path = plan.activePath.map((step) => theme.text(step.title)).join(theme.dim(" ▸ "));
		const right = ` ${planBar(plan.complete, plan.total, 10)} ${theme.muted(`${plan.complete}/${plan.total}`)}`;
		const rightWidth = visibleWidth(right);
		lines.push(fit(`${field("PLAN")}${theme.text(plan.title)}${path ? theme.dim(" ▸ ") + path : ""}`, width - rightWidth) + right);
	} else {
		lines.push(fit(`${field("GOAL")}${bridge?.lastPrompt ? theme.text(`"${bridge.lastPrompt}"`) : theme.dim("no roadmap")}`, width));
	}

	const activity = bridge?.activity;
	let now = theme.dim(row.status.label);
	if (row.status.kind === "working" && activity?.kind === "tool") {
		now = `${theme.working("⚙")} ${theme.text(activity.tool ?? "")} ${theme.muted(activity.detail ?? "")} ${theme.dim(fmtDuration(ctx.now - activity.since))}`;
	} else if (row.status.kind === "working") {
		now = `${theme.working("✎")} ${theme.text(row.status.label)}`;
	}
	const unit = row.resources?.consumers.find((consumer) => consumer.kind !== "self" && consumer.cpu >= 0.1);
	const unitText = unit ? theme.dim(`   ↳ ${unit.label.slice(0, 40)} `) + theme.muted(`${fmtCores(unit.cpu)} ${fmtBytes(unit.rss)}`) : "";
	lines.push(fit(`${field("NOW")}${now}${unitText}`, width));
	const work = backgroundLine(row, ctx.now, width);
	if (work) lines.push(work);
	if (row.status.kind === "error" && bridge?.lastError) lines.push(fit(`${field("ERROR")}${theme.error(bridge.lastError.message)}`, width));

	const laneWidth = Math.max(10, width - 8 - 40);
	lines.push(fit(`${field("60m")}${activityLane(row.lane.last(), laneWidth)}  ${laneLegend()}`, width));
	// Without a roadmap the GOAL line already shows the last prompt.
	if (bridge?.plan && bridge.lastPrompt) lines.push(fit(`${field("PROMPT")}${theme.text(`"${bridge.lastPrompt}"`)}`, width));
	const next = bridge ? [fit(`${field("NEXT")}${bridge.suggestion ? theme.text(`"${oneLine(bridge.suggestion)}"`) : theme.dim("—")}`, width)] : [];
	lines.push(...saidPane(bridge?.lastSaid, preview, width, maxLines - lines.length - next.length), ...next);
	return lines;
}

export function renderOverview(ctx: ViewContext, width: number, height: number): string[] {
	const lines = [titleBar(ctx, width, "overview")];
	const quota = quotaLine(ctx, width);
	if (quota) lines.push(quota);
	lines.push(hostLine(ctx, width), "");
	const rows = ctx.store.ordered();
	const cols = columns(width, rows);
	lines.push(headerRow(cols, width));
	const scale = scales(rows, ctx.now);
	for (const row of rows) lines.push(sessionRow(row, ctx, cols, width, scale));
	if (!rows.length) {
		lines.push("", fit(`  ${theme.text("No pi sessions running.")}`, width), fit(`  ${theme.dim("Press")} ${theme.bold(theme.accent("n"))} ${theme.dim("to start one.")}`, width));
	}
	if (ctx.selected) lines.push("", ...selectedSummary(ctx.selected, ctx, width, height - 2 - lines.length));
	return lines.slice(0, height - 1);
}
