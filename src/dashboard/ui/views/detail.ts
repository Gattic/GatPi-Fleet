import { visibleWidth } from "@earendil-works/pi-tui";
import { rowCwd, rowLabel, rowSty, type SessionRow } from "../../model/store.ts";
import { activityLane, gauge, hbar, planBar, sparkline, stackedArea } from "../charts.ts";
import { fit, fitRight, fmtBytes, fmtCores, fmtCost, fmtDuration, fmtTokens, oneLine, shortPath } from "../format.ts";
import type { TextPane } from "../text-pane.ts";
import { theme } from "../theme.ts";
import { backgroundLine, FIELD_WIDTH, field, laneLegend, MIN_CPU_SCALE, MIN_MEM_SCALE, minuteSeries, rule, type Spend, saidPane, sessionUsage, statusCell, titleBar, type ViewContext } from "./shared.ts";

/** 30 minutes of 2-second samples. */
const CHART_SAMPLES = 900;
const CHART_ROWS = { min: 1, max: 5 };
const TOOL_ROWS = { min: 1, max: 6 };
/** Continuation lines line up with the text after a field label. */
const INDENT = " ".repeat(FIELD_WIDTH);

const STEP_GLYPH: Record<string, string> = { done: "✔", verified: "✔", active: "▶", blocked: "⚠", skipped: "↷", paused: "Ⅱ", shelved: "▣" };

function stepText(step: { title: string; status: string }): string {
	const glyph = STEP_GLYPH[step.status] ?? "○";
	const paint = step.status === "done" || step.status === "verified" ? theme.working : step.status === "active" ? theme.accent : step.status === "blocked" ? theme.error : theme.dim;
	return paint(`${glyph} ${step.title}`);
}

function side(left: string[], right: string[], width: number): string[] {
	const leftWidth = Math.floor((width - 3) / 2);
	const rightWidth = width - 3 - leftWidth;
	const count = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let index = 0; index < count; index++) {
		lines.push(`${fit(left[index] ?? "", leftWidth)} ${theme.faint("│")} ${fit(right[index] ?? "", rightWidth)}`);
	}
	return lines;
}

function chart(title: string, direct: number[], indirect: number[], width: number, height: number, floor: number, format: (value: number) => string): string[] {
	const axis = 6;
	const max = Math.max(floor, ...direct.map((value, index) => (Number.isNaN(value) ? 0 : value) + (Number.isNaN(indirect[index]) ? 0 : indirect[index])));
	const rows = stackedArea(direct, indirect, Math.max(4, width - axis - 1), height, max);
	const lines = [`${theme.muted(title)}   ${theme.direct("▓")} ${theme.dim("pi")}  ${theme.indirect("▒")} ${theme.dim("indirect")}`];
	rows.forEach((row, index) => {
		const label = index === 0 ? format(max) : index === rows.length - 1 ? "0" : "";
		lines.push(`${theme.dim(fitRight(label, axis))}${theme.faint(label ? "┤" : "│")}${row}`);
	});
	return lines;
}

export interface DetailView {
	lines: string[];
	/** Rows of `lines` showing the SAID text, when there is one. */
	said?: { top: number; height: number };
}

/** `said` holds the SAID pane's scroll position across renders. */
export function renderDetail(ctx: ViewContext, width: number, height: number, said: TextPane): DetailView {
	const row = ctx.selected;
	const lines = [titleBar(ctx, width, "detail")];
	if (!row) return { lines: [...lines, "", fit(`  ${theme.dim("No session selected.")}`, width)] };
	const bridge = row.bridge;
	const half = Math.floor((width - 3) / 2);
	const head = [...headerLines(row, ctx, width), rule(width)];
	const usage = [rule(width), ...side(usageLines(row, ctx, half), consumerLines(row, width - 3 - half), width), rule(width)];
	const info = infoLines(row, ctx, width);
	const tail = [
		fit(`${field("NEXT")}${bridge?.suggestion ? theme.text(`"${oneLine(bridge.suggestion)}"`) : theme.dim("—")}`, width),
		fit(`${field("60m")}${activityLane(row.lane.last(), Math.max(10, width - 48))}  ${laneLegend()}`, width),
	];

	// Rows left after the fixed sections go to the charts first, then the tool list; SAID takes the rest.
	const tools = bridge?.tools.length ?? 0;
	const fixed = lines.length + head.length + 1 + usage.length + info.length + tail.length;
	let spare = height - 1 - fixed - CHART_ROWS.min - TOOL_ROWS.min - 1;
	const grow = (limit: number) => {
		const rows = Math.max(0, Math.min(limit, spare));
		spare -= rows;
		return rows;
	};
	const chartRows = CHART_ROWS.min + grow(CHART_ROWS.max - CHART_ROWS.min);
	const toolRows = TOOL_ROWS.min + grow(Math.min(TOOL_ROWS.max, Math.max(TOOL_ROWS.min, tools)) - TOOL_ROWS.min);
	const saidRows = 1 + Math.max(0, spare);

	lines.push(...head);
	lines.push(
		...side(
			chart("CPU cores · 30m", row.cpuDirect.last(CHART_SAMPLES), row.cpuIndirect.last(CHART_SAMPLES), half, chartRows, MIN_CPU_SCALE, fmtCores),
			chart("MEMORY · 30m", row.memDirect.last(CHART_SAMPLES), row.memIndirect.last(CHART_SAMPLES), width - 3 - half, chartRows, MIN_MEM_SCALE, fmtBytes),
			width,
		),
	);
	lines.push(...usage, ...toolLines(row, ctx, width, toolRows), ...info);
	const top = lines.length;
	const saidLines = saidPane(bridge?.lastSaid, said, width, saidRows);
	lines.push(...saidLines, ...tail);
	const free = height - 1 - lines.length;
	for (let index = 0; index < free; index++) lines.push("");
	return { lines: lines.slice(0, height - 1), said: bridge?.lastSaid ? { top, height: saidLines.length } : undefined };
}

function headerLines(row: SessionRow, ctx: ViewContext, width: number): string[] {
	const bridge = row.bridge;
	const cwd = rowCwd(row);
	const sty = rowSty(row);
	const startedAt = row.proc?.startedAt;
	const name = ` ${theme.bold(theme.text(`${row.slot ?? "·"} ${rowLabel(row)}`))}   ${statusCell(row, ctx)}`;
	// Ids that do not fit beside the name and status are left out whole rather than cut.
	const idParts = [`pid ${row.pid}`, sty ? `screen ${sty}` : "", startedAt && row.exitedAt === undefined ? `up ${fmtDuration(ctx.now - startedAt)}` : ""].filter(Boolean);
	while (idParts.length && visibleWidth(idParts.join(" · ")) > width - visibleWidth(name) - 4) idParts.pop();
	const ids = theme.dim(idParts.join(" · "));
	const meta = [
		cwd ? theme.muted(shortPath(cwd)) : "",
		bridge?.model ? theme.text(`${bridge.model}${bridge.thinking ? theme.muted(` · ${bridge.thinking}`) : ""}`) : "",
		bridge?.context?.percent != null ? `${theme.muted("ctx")} ${gauge(bridge.context.percent / 100, 12)} ${theme.muted(`${Math.round(bridge.context.percent)}%`)}` : "",
	].filter(Boolean);
	const lines = [fit(name, width - visibleWidth(ids) - 1) + ids + " ", fit(`   ${meta.join(theme.dim(" · "))}`, width)];
	const plan = bridge?.plan;
	if (plan) {
		const right = `${planBar(plan.complete, plan.total, 20)} ${theme.muted(`${plan.complete}/${plan.total}`)}`;
		lines.push(fit(`${field("PLAN")}${theme.bold(theme.text(plan.title))}${plan.lifecycle !== "active" ? theme.dim(` (${plan.lifecycle})`) : ""}`, width - visibleWidth(right) - 1) + ` ${right}`);
		lines.push(fit(`${INDENT}${plan.milestones.map(stepText).join("   ")}`, width));
		if (plan.activePath.length) lines.push(fit(`${INDENT}${plan.activePath.map((step) => `${theme.dim(`${step.path ?? ""} `)}${theme.text(step.title)}`).join(theme.dim(" ▸ "))}`, width));
	} else {
		lines.push(fit(`${field("PLAN")}${theme.dim("no roadmap published")}`, width));
	}
	return lines;
}

function usageLines(row: SessionRow, ctx: ViewContext, width: number): string[] {
	const bridge = row.bridge;
	if (!bridge) return [theme.dim("API usage unavailable without the bridge")];
	const spend = sessionUsage(row, ctx.usage);
	// Models without a price report no cost; their tokens are the only measure.
	const metric: keyof Spend = spend.total.cost > 0 ? "cost" : "tokens";
	const amount = (part: Spend) => (metric === "cost" ? `$${fmtCost(part.cost)}` : `${fmtTokens(part.tokens)} tok`);
	const max = Math.max(spend.direct[metric], spend.indirect[metric], spend.subagents[metric], 1e-9);
	const barWidth = Math.max(4, width - 30);
	const tokensPerMinute = minuteSeries(row, 60, ctx.now);
	const direct = bridge.usage.direct;
	const prompt = direct.input + direct.cacheRead + direct.cacheWrite;
	const cacheHit = prompt > 0 ? direct.cacheRead / prompt : 0;
	const label = (text: string) => theme.muted(text.padEnd(10));
	const bar = (name: string, part: Spend, paint: typeof theme.direct) => `${label(name)}${hbar(part[metric], max, barWidth, paint)} ${theme.text(amount(part))}`;
	return [
		`${theme.muted("API tokens/min · 60m")}   ${theme.dim(`${fmtTokens(spend.total.tokens)} total`)}`,
		sparkline(tokensPerMinute, Math.max(4, width), undefined, theme.indirect),
		bar("direct", spend.direct, theme.direct),
		bar("tools", spend.indirect, theme.indirect),
		bar("subagents", spend.subagents, theme.indirect),
		// Narrower than the bars, so the total fits after it.
		`${label("cache hit")}${gauge(cacheHit, Math.max(4, barWidth - 10), theme.working)} ${theme.text(`${Math.round(cacheHit * 100)}%`)}   ${theme.dim("total")} ${theme.bold(theme.text(amount(spend.total)))}`,
	];
}

function consumerLines(row: SessionRow, width: number): string[] {
	const lines = [`${fit(theme.muted("TOP CONSUMERS"), width - 14)}${theme.dim(fitRight("cpu", 6))}${theme.dim(fitRight("mem", 8))}`];
	const consumers = row.resources?.consumers ?? [];
	if (!consumers.length) lines.push(theme.dim("no live processes"));
	for (const consumer of consumers.slice(0, 5)) {
		const glyph = consumer.kind === "self" ? theme.direct("▓") : theme.indirect("▒");
		lines.push(`${fit(`${glyph} ${theme.text(consumer.label)}`, width - 14)}${theme.text(fitRight(fmtCores(consumer.cpu), 6))}${theme.text(fitRight(fmtBytes(consumer.rss), 8))}`);
	}
	const resources = row.resources;
	if (resources && (resources.directGpuMem || resources.indirectGpuMem)) lines.push(theme.dim(`gpu mem  pi ${fmtBytes(resources.directGpuMem)} · indirect ${fmtBytes(resources.indirectGpuMem)}`));
	return lines;
}

const TOOL_NAME_WIDTH = 16;
const TOOL_TIME_WIDTH = 8;

/** The latest tool runs, newest first: status, name, argument summary and duration. */
function toolLines(row: SessionRow, ctx: ViewContext, width: number, rows: number): string[] {
	const runs = (row.bridge?.tools ?? []).slice(-rows).reverse();
	if (!runs.length) return [fit(`${field("TOOLS")}${theme.dim("none yet")}`, width)];
	const detailWidth = Math.max(1, width - FIELD_WIDTH - 2 - TOOL_NAME_WIDTH - TOOL_TIME_WIDTH);
	return runs.map((run, index) => {
		const glyph = run.endedAt === undefined ? theme.working(ctx.spinner) : run.isError ? theme.error("✖") : theme.working("✔");
		const elapsed = (run.endedAt ?? ctx.now) - run.startedAt;
		const time = run.endedAt === undefined || elapsed >= 1000 ? fmtDuration(elapsed) : "";
		const text = `${glyph} ${fit(theme.text(run.name), TOOL_NAME_WIDTH)}${fit(theme.muted(run.detail), detailWidth)}${theme.dim(fitRight(time, TOOL_TIME_WIDTH))}`;
		return fit(`${index === 0 ? field("TOOLS") : INDENT}${text}`, width);
	});
}

function infoLines(row: SessionRow, ctx: ViewContext, width: number): string[] {
	const bridge = row.bridge;
	const lines = [fit(`${field("PROMPT")}${bridge?.lastPrompt ? theme.text(`"${bridge.lastPrompt}"`) : theme.dim("—")}`, width)];
	if (row.status.kind === "error" && bridge?.lastError) lines.push(fit(`${field("ERROR")}${theme.error(bridge.lastError.message)}`, width));
	const work = backgroundLine(row, ctx.now, width);
	if (work) lines.push(work);
	return lines;
}
