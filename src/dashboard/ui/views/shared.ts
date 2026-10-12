import { visibleWidth } from "@earendil-works/pi-tui";
import type { GpuMonitor } from "../../../manager/collectors/gpu.ts";
import { providerLabel, type QuotaMonitor } from "../../../manager/collectors/quota.ts";
import type { RemoteHost } from "../../../manager/remote/host.ts";
import { PROTOCOL_VERSION } from "../../../protocol/index.ts";
import { rowLabel, type SessionRow, type Store } from "../../../manager/model/store.ts";
import { startOfToday } from "../../../manager/usage/report.ts";
import type { UsageIndex } from "../../../manager/usage/usage-index.ts";
import { gauge, planBar, sparkline } from "../charts.ts";
import { fit, fitRight, fmtBytes, fmtCost, fmtDuration, fmtTokens, oneLine } from "../format.ts";
import type { TextPane } from "../text-pane.ts";
import { levelColor, type Paint, theme } from "../theme.ts";

export interface ViewContext {
	store: Store;
	/** Remote hosts by hosts.json name. */
	remotes: ReadonlyMap<string, RemoteHost>;
	usage: UsageIndex;
	quota: QuotaMonitor;
	gpu: GpuMonitor;
	now: number;
	/** Current spinner frame for working sessions. */
	spinner: string;
	selected?: SessionRow;
}

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** Memory bars and charts never scale below this, so small sessions do not look full. */
export const MIN_MEM_SCALE = 4 * 1024 ** 3;
/** CPU charts never scale below one core. */
export const MIN_CPU_SCALE = 1;

export type ViewName = "overview" | "detail" | "usage";

const TABS: [ViewName, string][] = [
	["overview", "sessions"],
	["detail", "detail"],
	["usage", "usage"],
];

/** Pad a styled line to `width` and paint a background across it. */
export function background(line: string, width: number, paint: Paint): string {
	return paint(fit(line, width));
}

/** API usage as pi's API-equivalent cost and as tokens (the only measure for models without a price). */
export interface Spend {
	cost: number;
	tokens: number;
}

export interface SessionUsage {
	direct: Spend;
	/** Nested LLM work done by tools. */
	indirect: Spend;
	subagents: Spend;
	total: Spend;
}

export function sessionUsage(row: SessionRow, usage: UsageIndex): SessionUsage {
	const bridge = row.bridge;
	const direct = { cost: bridge?.usage.direct.cost ?? 0, tokens: bridge?.usage.direct.tokens ?? 0 };
	const indirect = { cost: bridge?.usage.indirect.cost ?? 0, tokens: bridge?.usage.indirect.tokens ?? 0 };
	const sub = bridge ? usage.subagentUsage(bridge.sessionId) : undefined;
	const subagents = { cost: sub?.cost ?? 0, tokens: sub?.tokens ?? 0 };
	return { direct, indirect, subagents, total: { cost: direct.cost + indirect.cost + subagents.cost, tokens: direct.tokens + indirect.tokens + subagents.tokens } };
}

/** Columns taken by a row label such as PLAN or SAID, including its margins. */
export const FIELD_WIDTH = 8;

/** A dim row label; the content after it starts at column FIELD_WIDTH. */
export function field(label: string): string {
	return ` ${theme.dim(fit(label, FIELD_WIDTH - 2))} `;
}

/** The latest reply as Markdown in up to `rows` lines; the label column shows how much is above and below. */
export function saidPane(text: string | undefined, pane: TextPane, width: number, rows: number): string[] {
	if (!text) return [fit(`${field("SAID")}${theme.dim("—")}`, width)];
	pane.setText(text);
	const view = pane.render(Math.max(1, width - FIELD_WIDTH), Math.max(1, rows));
	const labels = view.lines.map((_, index): string => (index === 0 ? "SAID" : ""));
	if (labels.length > 1 && view.above) labels[1] = `▲ ${view.above}`;
	if (labels.length > 1 && view.below) labels[labels.length - 1] = `▼ ${view.below}`;
	return view.lines.map((line, index) => fit(`${field(labels[index])}${line}`, width));
}

export function titleBar(ctx: ViewContext, width: number, view: ViewName): string {
	const rows = ctx.store.ordered();
	const working = rows.filter((row) => row.status.kind === "working" || row.status.kind === "rate-limited" || row.status.kind === "stalled").length;
	const waiting = rows.filter((row) => row.status.kind === "needs-you").length;
	const errors = rows.filter((row) => row.status.kind === "error").length;
	// Narrow terminals get the counts without their words.
	const counts = (long: boolean) =>
		[
			working ? theme.working(`${ctx.spinner} ${working}${long ? " working" : ""}`) : "",
			waiting ? theme.waiting(`◆ ${waiting}${long ? " needs you" : ""}`) : "",
			errors ? theme.error(`✖ ${errors}${long ? " error" : ""}`) : "",
		]
			.filter(Boolean)
			.join(long ? "   " : "  ");
	const clock = new Date(ctx.now).toTimeString().slice(0, 5);
	const tabs = TABS.map(([name, label]) => (name === view ? theme.chip(theme.bold(theme.text(` ${label} `))) : theme.dim(` ${label} `))).join("");
	const left = ` ${theme.bold(theme.indirect("pi-dash"))}  ${tabs}`;
	let right = `${counts(true)}   ${theme.muted(clock)} `;
	if (visibleWidth(left) + visibleWidth(right) >= width) right = `${counts(false)}  ${theme.muted(clock)} `;
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return background(left + " ".repeat(gap) + right, width, theme.bar);
}

export function quotaLines(ctx: ViewContext, width: number): string[] {
	const accounts = ctx.quota.snapshot(ctx.now);
	if (!accounts?.length) return [fit(`${field("QUOTA")}${theme.dim(accounts === null ? "unknown · logins unavailable" : "no logins")}`, width)];
	return accounts.flatMap((account) => {
		const provider = theme.text(providerLabel(account.provider));
		if (!account.windows.length) return [fit(`${field("QUOTA")}${provider} ${theme.muted(account.status)} · ${theme.dim(account.message ?? "")}`, width)];
		return account.windows.map((window) => {
			const fresh = account.status === "fresh";
			const left = Math.round(100 - window.usedPercent);
			const paint = fresh ? levelColor(window.usedPercent / 100) : theme.dim;
			const reset = window.resetAt > ctx.now ? `↻ ${fmtDuration(window.resetAt - ctx.now)}` : "reset due";
			return fit(`${field("QUOTA")}${provider} ${theme.muted(window.label)} ${gauge(left / 100, width >= 100 ? 10 : 6, paint)} ${paint(`${left}% left`)} ${theme.dim(reset)}${fresh ? "" : theme.waiting(" · stale")}`, width);
		});
	});
}

export function cooldownLine(ctx: ViewContext, width: number): string {
	const cooldowns = ctx.quota.activeCooldowns(ctx.now);
	const text = cooldowns === null ? theme.muted("unknown (state unavailable)") : cooldowns.length
		? cooldowns.map(({ provider, until }) => `${theme.text(providerLabel(provider))} ${theme.waiting(fmtDuration(until - ctx.now))}`).join("   ")
		: theme.dim("none recorded");
	return fit(`${theme.dim(" COOLDOWN ")}${text}`, width);
}

export function hostLine(ctx: ViewContext, width: number): string {
	const host = ctx.store.host;
	const spark = width >= 120 ? 12 : width >= 100 ? 6 : 0;
	const trend = (values: number[]) => (spark ? `${sparkline(values, spark, 1)} ` : "");
	const parts: string[] = [];
	const today = ctx.usage.total(startOfToday(ctx.now));
	const hourly = ctx.usage.series(startOfToday(ctx.now), ctx.now, 1, "cost");
	const todayText = ctx.usage.scanned || ctx.usage.files.size ? `${theme.muted("today")} ${theme.text(`$${fmtCost(today.cost)}`)}${spark ? ` ${sparkline(hourly, Math.min(12, Math.max(1, hourly.length)))}` : ""}` : theme.dim("today …");
	parts.push(`${theme.muted("cpu")} ${trend(ctx.store.hostCpu.last(spark * 15))}${theme.text(`${Math.round((host?.cpu ?? 0) * 100)}%`)}`);
	if (host) parts.push(`${theme.muted("mem")} ${gauge(host.memUsed / Math.max(1, host.memTotal), width >= 120 ? 12 : 8)} ${theme.text(fmtBytes(host.memUsed))}${theme.dim(`/${fmtBytes(host.memTotal)}`)}`);
	const gpu = ctx.store.gpu;
	if (gpu && ctx.gpu.available) parts.push(`${theme.muted("gpu")} ${trend(ctx.store.gpuUtil.last(spark * 15))}${theme.text(`${Math.round(gpu.utilization * 100)}%`)}${spark ? ` ${theme.text(fmtBytes(gpu.memUsed))}${theme.dim(`/${fmtBytes(gpu.memTotal)}`)}` : ""}`);
	parts.push(todayText);
	return fit(`${field("HOST")}${parts.join(width >= 100 ? "    " : "   ")}`, width);
}

/** A remote host's link for pickers: online (and which machine), connecting, or offline and why. */
export function hostStatusText(remote: RemoteHost, now: number): string {
	const status = remote.status;
	switch (status.kind) {
		case "online":
			return `online · ${status.hostname}`;
		case "connecting":
			return "connecting…";
		case "offline":
			return `offline ${fmtDuration(now - status.since)}: ${status.error}`;
	}
}

/** One cell per remote host: link state, and CPU and memory while online (`detail`) or why it is offline. */
function hostCell(remote: RemoteHost, now: number, detail: boolean): string {
	const status = remote.status;
	if (status.kind === "connecting") return `${theme.dim("…")} ${theme.muted(remote.name)}`;
	if (status.kind === "offline") {
		const why = detail ? `: ${oneLine(status.error).slice(0, 48)}` : "";
		return `${theme.error("✖")} ${theme.muted(remote.name)} ${theme.dim(`offline ${fmtDuration(now - status.since)}${why}`)}`;
	}
	const vitals = remote.vitals?.host;
	const load = detail && vitals ? ` ${theme.muted(`${Math.round(vitals.cpu * 100)}%`)} ${theme.dim(`${fmtBytes(vitals.memUsed)}/${fmtBytes(vitals.memTotal)}`)}` : "";
	return `${theme.working("●")} ${theme.text(remote.name)}${load}`;
}

/** The remote hosts' links; undefined without remote hosts. */
export function hostsLine(ctx: ViewContext, width: number): string | undefined {
	const remotes = [...ctx.remotes.values()];
	if (!remotes.length) return undefined;
	let line = "";
	for (const detail of [true, false]) {
		line = `${field("HOSTS")}${remotes.map((remote) => hostCell(remote, ctx.now, detail)).join("   ")}`;
		if (visibleWidth(line) <= width) break;
	}
	return fit(line, width);
}

/** Faint horizontal rule, optionally with a label after a short lead-in. */
export function rule(width: number, label = ""): string {
	if (!label) return theme.faint("─".repeat(width));
	const text = fit(` ${label} `, Math.min(width - 3, visibleWidth(label) + 2));
	return fit(theme.faint("──") + text + theme.faint("─".repeat(Math.max(0, width - 2 - visibleWidth(text)))), width);
}

const ACTIVITY_ICON: Record<string, string> = { tool: "⚙", thinking: "✎", writing: "✎", compacting: "⟳", continuing: "⟳", model: "…" };

export function statusCell(row: SessionRow, ctx: ViewContext): string {
	const status = row.status;
	const timer = status.since !== undefined ? theme.dim(` ${fmtDuration(ctx.now - status.since)}`) : "";
	if (row.incompatibleVersion !== undefined) {
		// An older bridge is updated by /reload in that session; a newer one needs a newer pi-dash.
		const fix = row.incompatibleVersion < PROTOCOL_VERSION ? "/reload it" : "update pi-dash";
		return theme.error(`✖ bridge v${row.incompatibleVersion}: ${fix}`);
	}
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
		return fit(`${planBar(plan.complete, plan.total, 6)} ${theme.muted(`${plan.complete}/${plan.total}`)} ${done ? theme.working(leaf) : theme.text(leaf)}`, width);
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
	if (row.exitedAt !== undefined) return fit(theme.dim(label), width);
	return fit(selected ? theme.bold(theme.text(label)) : theme.text(label), width);
}

/** Dollars when the models have a price, otherwise tokens marked `t`. */
export function spendText(spend: Spend, width: number): string {
	if (spend.cost > 0) return fitRight(theme.text(fmtCost(spend.cost)), width);
	if (spend.tokens > 0) return fitRight(theme.muted(`${fmtTokens(spend.tokens)}t`), width);
	return fitRight(theme.dim("—"), width);
}

/** Compact count of a session's background work, e.g. `2j 1s` (jobs, subagents). */
export function backgroundBadge(row: SessionRow): string {
	const work = row.exitedAt === undefined ? (row.resources?.background ?? []) : [];
	const jobs = work.filter((item) => item.kind === "job").length;
	const subagents = work.length - jobs;
	const part = (count: number, letter: string) => (count ? `${theme.text(String(count))}${theme.dim(letter)}` : "");
	return [part(jobs, "j"), part(subagents, "s")].filter(Boolean).join(" ");
}

/** The session's background jobs and subagents with their age, when it has any. */
export function backgroundLine(row: SessionRow, now: number, width: number): string | undefined {
	const work = row.exitedAt === undefined ? (row.resources?.background ?? []) : [];
	if (!work.length) return undefined;
	const items = work.map((item) => `${theme.muted(item.kind)} ${theme.text(item.label)} ${theme.dim(fmtDuration(now - item.startedAt))}`);
	return fit(`${field("BG")}${items.join(theme.faint("  ·  "))}`, width);
}

export function laneLegend(): string {
	return `${theme.working("█")}${theme.dim(" working  ")}${theme.waiting("▒")}${theme.dim(" waiting on you  ")}${theme.dim("░ idle")}`;
}
