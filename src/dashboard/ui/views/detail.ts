import { visibleWidth } from "@earendil-works/pi-tui";
import { rowCwd, rowLabel, rowSty, type SessionRow } from "../../model/store.ts";
import { activityLane, gauge, hbar, planBar, sparkline, stackedArea } from "../charts.ts";
import { fit, fitRight, fmtBytes, fmtCores, fmtCost, fmtDuration, fmtTokens, oneLine, shortPath } from "../format.ts";
import type { TextPane } from "../text-pane.ts";
import { theme } from "../theme.ts";
import { FIELD_WIDTH, field, laneLegend, minuteSeries, rule, saidPane, sessionCost, statusCell, titleBar, type ViewContext } from "./shared.ts";

/** 30 minutes of 2-second samples. */
const CHART_SAMPLES = 900;
const CHART_HEIGHT = 5;
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

function chart(title: string, direct: number[], indirect: number[], width: number, format: (value: number) => string): string[] {
	const axis = 6;
	const max = Math.max(1e-9, ...direct.map((value, index) => (Number.isNaN(value) ? 0 : value) + (Number.isNaN(indirect[index]) ? 0 : indirect[index])));
	const rows = stackedArea(direct, indirect, Math.max(4, width - axis - 1), CHART_HEIGHT, max);
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
	lines.push(...headerLines(row, ctx, width));
	const half = Math.floor((width - 3) / 2);
	lines.push(rule(width));
	lines.push(...side(chart("CPU cores · 30m", row.cpuDirect.last(CHART_SAMPLES), row.cpuIndirect.last(CHART_SAMPLES), half, fmtCores), chart("MEMORY · 30m", row.memDirect.last(CHART_SAMPLES), row.memIndirect.last(CHART_SAMPLES), width - 3 - half, fmtBytes), width));
	lines.push(rule(width));
	lines.push(...side(usageLines(row, ctx, half), consumerLines(row, width - 3 - half), width));
	lines.push(rule(width));
	lines.push(...activityLines(row, ctx, width));
	const bridge = row.bridge;
	const tail = [
		fit(`${field("NEXT")}${bridge?.suggestion ? theme.text(`"${oneLine(bridge.suggestion)}"`) : theme.dim("—")}`, width),
		fit(`${field("60m")}${activityLane(row.lane.last(), Math.max(10, width - 48))}  ${laneLegend()}`, width),
	];
	// SAID takes the rows that are left.
	const top = lines.length;
	const saidLines = saidPane(bridge?.lastSaid, said, width, height - 1 - top - tail.length);
	lines.push(...saidLines, ...tail);
	const free = height - 1 - lines.length;
	for (let index = 0; index < free; index++) lines.push("");
	return { lines: lines.slice(0, height - 1), said: bridge?.lastSaid ? { top, height: saidLines.length } : undefined };
}

function headerLines(row: SessionRow, ctx: ViewContext, width: number): string[] {
	const bridge = row.bridge;
	const cwd = rowCwd(row);
	const sty = rowSty(row);
	const uptime = row.cpuDirect.length * 2000;
	const name = ` ${theme.bold(theme.text(`${row.slot ?? "·"} ${rowLabel(row)}`))}   ${statusCell(row, ctx)}`;
	// Ids that do not fit beside the name and status are left out whole rather than cut.
	const idParts = [`pid ${row.pid}`, sty ? `screen ${sty}` : "", uptime ? `seen ${fmtDuration(uptime)}` : ""].filter(Boolean);
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
	const cost = sessionCost(row, ctx.usage);
	const subagents = ctx.usage.subagentUsage(bridge.sessionId);
	const max = Math.max(cost.direct, cost.indirect, cost.subagents, 1e-9);
	const barWidth = Math.max(4, width - 28);
	const tokensPerMinute = minuteSeries(row, 60, ctx.now);
	const direct = bridge.usage.direct;
	const prompt = direct.input + direct.cacheRead + direct.cacheWrite;
	const cacheHit = prompt > 0 ? direct.cacheRead / prompt : 0;
	const label = (text: string) => theme.muted(text.padEnd(10));
	return [
		`${theme.muted("API tokens/min · 60m")}   ${theme.dim(`${fmtTokens(direct.tokens + bridge.usage.indirect.tokens + subagents.tokens)} total`)}`,
		sparkline(tokensPerMinute, Math.max(4, width), undefined, theme.indirect),
		`${label("direct")}${hbar(cost.direct, max, barWidth, theme.direct)} ${theme.text(`$${fmtCost(cost.direct)}`)}`,
		`${label("tools")}${hbar(cost.indirect, max, barWidth, theme.indirect)} ${theme.text(`$${fmtCost(cost.indirect)}`)}`,
		`${label("subagents")}${hbar(cost.subagents, max, barWidth, theme.indirect)} ${theme.text(`$${fmtCost(cost.subagents)}`)}`,
		`${label("cache hit")}${gauge(cacheHit, barWidth, theme.working)} ${theme.text(`${Math.round(cacheHit * 100)}%`)}   ${theme.dim("total")} ${theme.bold(theme.text(`$${fmtCost(cost.total)}`))}`,
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

function activityLines(row: SessionRow, ctx: ViewContext, width: number): string[] {
	const bridge = row.bridge;
	const lines: string[] = [];
	const tools = (bridge?.tools ?? []).slice(-8).map((run) => {
		const glyph = run.endedAt === undefined ? theme.working(ctx.spinner) : run.isError ? theme.error("✖") : theme.working("✔");
		const elapsed = ((run.endedAt ?? ctx.now) - run.startedAt) / 1000;
		return `${theme.text(run.name)} ${glyph}${elapsed >= 1 ? theme.dim(` ${fmtDuration(elapsed * 1000)}`) : ""}`;
	});
	lines.push(fit(`${field("TOOLS")}${tools.length ? tools.join(theme.faint("  ·  ")) : theme.dim("none yet")}`, width));
	lines.push(fit(`${field("PROMPT")}${bridge?.lastPrompt ? theme.text(`"${bridge.lastPrompt}"`) : theme.dim("—")}`, width));
	if (row.status.kind === "error" && bridge?.lastError) lines.push(fit(`${field("ERROR")}${theme.error(bridge.lastError.message)}`, width));
	return lines;
}
