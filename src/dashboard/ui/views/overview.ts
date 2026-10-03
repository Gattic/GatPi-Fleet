import { rowCwd, rowSty, type SessionRow } from "../../model/store.ts";
import { activityLane, gauge, planBar, sparkline, splitBar } from "../charts.ts";
import { fit, fitRight, fmtBytes, fmtCores, fmtDuration, shortPath } from "../format.ts";
import { theme } from "../theme.ts";
import {
	background,
	costText,
	cpuSeries,
	hostLine,
	laneLegend,
	minuteSeries,
	planCell,
	quotaLine,
	rowName,
	rule,
	sessionCost,
	statusCell,
	titleBar,
	type ViewContext,
} from "./shared.ts";

/** Samples behind the per-row CPU sparkline (2 minutes at 2 s). */
const CPU_SPARK_SAMPLES = 60;
const MIN_MEM_SCALE = 4 * 1024 ** 3;

interface Columns {
	name: number;
	state: number;
	plan: number;
	cpu: number;
	mem: number;
	api: number;
	cost: number;
}

function columns(width: number): Columns {
	const full = width >= 100;
	const fixed = { name: full ? 12 : 10, state: full ? 22 : 18, cpu: 11, mem: full ? 13 : 0, api: full ? 7 : 0, cost: 6 };
	const separators = full ? 8 : 6;
	const plan = Math.max(8, width - 2 - separators - fixed.name - fixed.state - fixed.cpu - fixed.mem - fixed.api - fixed.cost);
	return { ...fixed, plan };
}

function headerRow(cols: Columns, width: number): string {
	const parts = ["  ", fit("SESSION", cols.name), fit("STATE", cols.state), fit("PLAN", cols.plan), fit("CPU", cols.cpu)];
	if (cols.mem) parts.push(fit(`MEM ${theme.direct("▓")}${theme.indirect("▒")}`, cols.mem));
	if (cols.api) parts.push(fit("API/m", cols.api));
	parts.push(fitRight("$", cols.cost));
	return fit(theme.dim(parts.join(" ")), width);
}

function sessionRow(row: SessionRow, ctx: ViewContext, cols: Columns, width: number, memScale: number): string {
	const selected = ctx.selected === row;
	const marker = selected ? theme.accent("▶") : " ";
	const slot = row.slot !== undefined ? theme.muted(String(row.slot)) : theme.dim("·");
	const live = row.exitedAt === undefined;
	const resources = row.resources;
	const cpuText = live && resources ? `${sparkline(cpuSeries(row, CPU_SPARK_SAMPLES), 5, undefined, theme.working)} ${fitRight(fmtCores(resources.directCpu + resources.indirectCpu), 5)}` : "";
	const parts = [marker + slot, rowName(row, cols.name, selected), fit(statusCell(row, ctx), cols.state), planCell(row, cols.plan), fit(cpuText, cols.cpu)];
	if (cols.mem) {
		const memText = live && resources ? `${splitBar(resources.directMem, resources.indirectMem, memScale, 7)} ${fitRight(fmtBytes(resources.directMem + resources.indirectMem), 5)}` : "";
		parts.push(fit(memText, cols.mem));
	}
	if (cols.api) parts.push(fit(row.bridge ? sparkline(minuteSeries(row, 12, ctx.now), 6, undefined, theme.indirect) : "", cols.api));
	parts.push(costText(row.bridge ? sessionCost(row, ctx.usage).total : 0, cols.cost));
	const line = parts.join(" ");
	if (row.alertUntil !== undefined) return background(line, width, theme.alert);
	return selected ? background(line, width, theme.selected) : fit(line, width);
}

function selectedSummary(row: SessionRow, ctx: ViewContext, width: number): string[] {
	const bridge = row.bridge;
	const lines: string[] = [];
	const cwd = rowCwd(row);
	const sty = rowSty(row);
	const head = [
		`${row.slot ?? "·"} ${theme.bold(theme.text(bridge?.name || (cwd ? cwd.split("/").pop() : `pi ${row.pid}`) || ""))}`,
		cwd ? shortPath(cwd) : "",
		bridge?.model ? `${bridge.model.split("/").pop()}${bridge.thinking ? ` ${bridge.thinking}` : ""}` : "",
		bridge?.context?.percent != null ? `ctx ${gauge(bridge.context.percent / 100, 12)}${Math.round(bridge.context.percent)}%` : "",
		sty ? `screen ${sty}` : "",
	].filter(Boolean);
	lines.push(rule(width, head.join(theme.dim(" · "))));

	const label = (text: string) => theme.dim(text.padEnd(6));
	if (bridge?.plan) {
		const plan = bridge.plan;
		const path = plan.activePath.map((step) => step.title).join(theme.dim(" ▸ "));
		const right = ` ${planBar(plan.complete, plan.total, 10)} ${plan.complete}/${plan.total}`;
		lines.push(fit(` ${label("PLAN")}${theme.text(plan.title)}${path ? theme.dim(" ▸ ") + path : ""}`, width - 16) + fitRight(right, 16));
	} else {
		lines.push(fit(` ${label("GOAL")}${bridge?.lastPrompt ? theme.text(`"${bridge.lastPrompt}"`) : theme.dim("no roadmap")}`, width));
	}

	const activity = bridge?.activity;
	let now = theme.dim(row.status.label);
	if (row.status.kind === "working" && activity?.kind === "tool") {
		now = `${theme.working("⚙")} ${theme.text(activity.tool ?? "")} ${theme.muted(activity.detail ?? "")} ${theme.dim(fmtDuration(ctx.now - activity.since))}`;
	} else if (row.status.kind === "working") {
		now = `${theme.working("✎")} ${theme.text(row.status.label)}`;
	}
	const unit = row.resources?.consumers.find((consumer) => consumer.kind !== "self" && consumer.cpu >= 0.1);
	const unitText = unit ? theme.dim(`  ↳ ${unit.label.slice(0, 40)} `) + theme.muted(`${fmtCores(unit.cpu)} ${fmtBytes(unit.rss)}`) : "";
	lines.push(fit(` ${label("NOW")}${now}${unitText}`, width));

	if (row.status.kind === "error" && bridge?.lastError) lines.push(fit(` ${label("ERROR")}${theme.error(bridge.lastError.message)}`, width));
	else lines.push(fit(` ${label("SAID")}${bridge?.lastSaid ? theme.muted(`"${bridge.lastSaid}"`) : theme.dim("—")}`, width));

	const laneWidth = Math.max(10, width - 8 - 40);
	lines.push(fit(` ${label("60m")}${activityLane(row.lane.last(), laneWidth)}  ${laneLegend()}`, width));
	return lines;
}

export function renderOverview(ctx: ViewContext, width: number, height: number): string[] {
	const lines = [titleBar(ctx, width, "sessions")];
	const quota = quotaLine(ctx, width);
	if (quota) lines.push(quota);
	lines.push(hostLine(ctx, width));
	lines.push(rule(width));
	const cols = columns(width);
	lines.push(headerRow(cols, width));
	const rows = ctx.store.ordered();
	const memScale = Math.max(MIN_MEM_SCALE, ...rows.map((row) => (row.resources ? row.resources.directMem + row.resources.indirectMem : 0)));
	if (!rows.length) {
		lines.push(fit(theme.dim("  No pi sessions found. Press n to start one."), width));
	}
	for (const row of rows) lines.push(sessionRow(row, ctx, cols, width, memScale));
	const summary = ctx.selected ? selectedSummary(ctx.selected, ctx, width) : [];
	const free = height - 1 - lines.length - summary.length;
	for (let index = 0; index < free; index++) lines.push("");
	lines.push(...summary);
	return lines.slice(0, height - 1);
}
