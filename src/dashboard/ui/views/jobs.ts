import { visibleWidth } from "@earendil-works/pi-tui";
import type { Background } from "../../../manager/collectors/procs.ts";
import { rowLabel, type SessionRow } from "../../../manager/model/store.ts";
import { fit, fitRight, fmtBytes, fmtCores, fmtDuration } from "../format.ts";
import { theme } from "../theme.ts";
import { titleBar, type ViewContext } from "./shared.ts";

export interface JobRow {
	session: SessionRow;
	work: Background;
}

/** Every live background job and subagent, in session order and oldest first within a session. */
export function jobRows(rows: readonly SessionRow[]): JobRow[] {
	return rows
		.filter((row) => row.exitedAt === undefined)
		.flatMap((session) => (session.resources?.background ?? []).map((work) => ({ session, work })));
}

/** Rows left for jobs after the title, summary, blank line and column header. */
export function jobPageSize(height: number): number {
	return Math.max(1, height - 5);
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function sessionCell(session: SessionRow): string {
	return `${session.slot !== undefined ? `${session.slot} ` : ""}${rowLabel(session)}`;
}

/** All background work across sessions: what each job or subagent runs, its age, and its current CPU/memory. */
export function renderJobs(ctx: ViewContext, width: number, height: number, offset: number): string[] {
	const jobs = jobRows(ctx.store.ordered());
	const lines = [titleBar(ctx, width, "jobs")];
	const jobsCount = jobs.filter((job) => job.work.kind === "job").length;
	const subagents = jobs.length - jobsCount;
	const sessions = new Set(jobs.map((job) => job.session.key)).size;
	const summary = [
		jobsCount ? plural(jobsCount, "job", "jobs") : "",
		subagents ? plural(subagents, "subagent", "subagents") : "",
	].filter(Boolean).join(" · ");
	const page = jobPageSize(height);
	const start = Math.max(0, Math.min(offset, Math.max(0, jobs.length - page)));
	const position = jobs.length > page ? `  ${theme.dim(`${start + 1}–${Math.min(jobs.length, start + page)} of ${jobs.length}`)}` : "";
	const across = sessions ? theme.dim(` across ${plural(sessions, "session", "sessions")}`) : "";
	lines.push(fit(` ${theme.bold(theme.text("Background work"))}  ${theme.text(summary || "none")}${across}${position}`, width));
	lines.push("");
	if (!jobs.length) {
		lines.push(fit(`  ${theme.text("No background jobs or subagents.")}`, width));
		lines.push(fit(`  ${theme.dim("They appear here while a session's bg_run job or subagent runs.")}`, width));
		return lines.slice(0, Math.max(0, height - 1));
	}

	const wide = width >= 100;
	const kindWidth = 8;
	const ageWidth = 6;
	const cpuWidth = wide ? 6 : 0;
	const memWidth = wide ? 7 : 0;
	const gaps = wide ? 6 : 4;
	const longestName = Math.max(0, ...jobs.map((job) => visibleWidth(sessionCell(job.session))));
	const longestJob = Math.max(0, ...jobs.map((job) => visibleWidth(job.work.label)));
	let nameWidth = Math.max(8, Math.min(18, longestName));
	let jobWidth = Math.max(8, Math.min(24, longestJob));
	let whatWidth = width - 1 - gaps - kindWidth - ageWidth - cpuWidth - memWidth - nameWidth - jobWidth;
	// WHAT is the point of the page: take room from the names and labels before truncating it.
	if (whatWidth < 12) {
		const shrink = Math.min(12 - whatWidth, jobWidth - 8);
		jobWidth -= shrink;
		whatWidth += shrink;
	}
	if (whatWidth < 12) {
		const shrink = Math.min(12 - whatWidth, nameWidth - 8);
		nameWidth -= shrink;
		whatWidth += shrink;
	}
	whatWidth = Math.max(8, whatWidth);

	const header = [fit("SESSION", nameWidth), fit("KIND", kindWidth), fit("JOB", jobWidth), fitRight("AGE", ageWidth)];
	if (wide) header.push(fitRight("CPU", cpuWidth), fitRight("MEM", memWidth));
	header.push(fit("WHAT", whatWidth));
	lines.push(fit(` ${theme.dim(header.join(" "))}`, width));

	for (const job of jobs.slice(start, start + page)) {
		const session = job.session;
		const kind = job.work.kind === "job" ? theme.working("job") : theme.indirect("subagent");
		const cells = [
			fit(theme.text(sessionCell(session)), nameWidth),
			fit(kind, kindWidth),
			fit(theme.text(job.work.label), jobWidth),
			fitRight(theme.muted(fmtDuration(ctx.now - job.work.startedAt)), ageWidth),
		];
		if (wide) cells.push(fitRight(theme.text(fmtCores(job.work.cpu)), cpuWidth), fitRight(theme.text(fmtBytes(job.work.rss)), memWidth));
		cells.push(fit(theme.muted(job.work.detail ?? "—"), whatWidth));
		lines.push(fit(` ${cells.join(" ")}`, width));
	}
	return lines.slice(0, Math.max(0, height - 1));
}
