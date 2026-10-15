import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { hostRows, openCwds, rowCwd, rowIncarnation, rowLabel, type SessionRow } from "../manager/model/store.ts";
import { isAlert } from "../manager/model/status.ts";
import { launchSession, resumeBlocked } from "../manager/actions/launch.ts";
import { listProjects, listSessions, type Project, type SessionSummary } from "../manager/actions/sessions.ts";
import type { ManagerRuntime } from "../manager/runtime.ts";
import { MAX_PROMPTS } from "../protocol/index.ts";
import { ApiError, type CommandRequest, type LaunchRequest, MAX_PROMPT } from "./contract.ts";

type CommandKind = CommandRequest["command"]["kind"];
const COMMANDS = ["prompt", "ask", "abort", "shutdown", "compact", "rename", "model", "thinking", "dismiss"] as const satisfies readonly CommandKind[];

/** A directory to start or resume pi in, on this machine (host null) or a remote host. */
export interface ProjectChoice {
	id: string;
	host: string | null;
	label: string;
	path: string;
}

export const ref = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
export const clean = (text: string | undefined, max = 500): string | null => text === undefined ? null : stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, max);
export function sessionRef(row: SessionRow): string {
	return ref(rowIncarnation(row));
}
export function revision(row: SessionRow): string {
	return ref(JSON.stringify([sessionRef(row), row.bridge?.phase, row.bridge?.phaseSince, row.bridge?.lastSettledAt, row.bridge?.model, row.bridge?.thinking, row.exitedAt]));
}
export function disabled(row: SessionRow, kind: CommandKind): string | null {
	if (kind === "dismiss") return row.exitedAt === undefined ? "Only exited sessions can be dismissed" : null;
	if (row.exitedAt !== undefined) return "Session exited";
	if (row.incompatibleVersion !== undefined) return "Reload the bridge locally (/reload)";
	if (!row.bridge) return "No bridge; reload this session locally";
	if (!row.connected) return "Session bridge disconnected";
	if (kind === "compact" && row.bridge.phase !== "idle") return "Compact only while idle";
	if (kind === "ask" && row.bridge.asks.some((ask) => ask.status === "answering")) return "A side question is still answering";
	return null;
}

export function summary(row: SessionRow, gpuAvailable = false) {
	const b = row.bridge;
	const r = row.resources;
	return {
		id: sessionRef(row), revision: revision(row), label: clean(rowLabel(row), 120), project: clean(rowCwd(row)),
		status: { ...row.status, label: row.status.kind === "error" ? "error" : clean(row.status.label, 120), since: row.status.since ?? null },
		attentionKey: isAlert(row.status.kind) ? `${sessionRef(row)}:${row.status.kind}:${row.status.since ?? 0}` : null,
		connected: row.connected, model: clean(b?.model, 500), thinking: clean(b?.thinking, 20),
		contextPercent: b?.context?.percent ?? null,
		plan: b?.plan ? { title: clean(b.plan.title), complete: b.plan.complete, total: b.plan.total, blocked: b.plan.blocked, active: clean(b.plan.activePath.map((s) => s.title).join(" / ")) } : null,
		resources: r ? { cpu: r.directCpu + r.indirectCpu, memory: r.directMem + r.indirectMem, gpuMemory: gpuAvailable ? r.directGpuMem + r.indirectGpuMem : null } : null,
		usage: b ? { tokens: b.usage.direct.tokens + b.usage.indirect.tokens, cost: b.usage.direct.cost + b.usage.indirect.cost } : null,
		commands: Object.fromEntries(COMMANDS.map((kind) => [kind, disabled(row, kind)])),
	};
}

function choices(host: string | undefined, projects: readonly Project[]): ProjectChoice[] {
	return projects.slice(0, 200).map(({ cwd }) => ({ id: ref(host === undefined ? cwd : `${host}:${cwd}`), host: host ?? null, label: basename(cwd), path: cwd }));
}

export class Sessions {
	readonly runtime: ManagerRuntime;
	constructor(runtime: ManagerRuntime) { this.runtime = runtime; }
	overview() { return this.runtime.store.ordered().map((r) => summary(r, Boolean(this.runtime.gpu.latest))); }
	find(id: string): SessionRow {
		const row = this.runtime.store.ordered().find((row) => sessionRef(row) === id);
		if (!row) throw new ApiError(404, "Session no longer exists; refresh");
		return row;
	}
	detail(id: string) {
		const row = this.find(id);
		const b = row.bridge;
		return {
			...summary(row, Boolean(this.runtime.gpu.latest)),
			lastPrompt: clean(b?.lastPrompt, 200),
			// Only prompts short enough for the phone to send again.
			prompts: b?.prompts.slice(-MAX_PROMPTS).filter((p) => p.length <= MAX_PROMPT).map((p) => clean(p, MAX_PROMPT)) ?? [],
			lastSaid: clean(b?.lastSaid, 32_000), suggestion: clean(b?.suggestion, 2000),
			error: clean(b?.lastError?.message), models: b?.models.slice(0, 1000) ?? [],
			tools: b?.tools.slice(-20).map((t) => ({ name: clean(t.name, 100), detail: clean(t.detail, 100), startedAt: t.startedAt, endedAt: t.endedAt ?? null, isError: t.isError ?? false })) ?? [],
			asks: b?.asks.slice(-10).map((a) => ({ id: a.id, askedAt: a.askedAt, status: a.status, question: clean(a.question, 4000), answer: clean(a.answer, 32_000), error: clean(a.error), cost: a.usage?.cost ?? null })) ?? [],
		};
	}
	async command(id: string, input: CommandRequest): Promise<void> {
		const row = this.find(id);
		if (revision(row) !== input.revision) throw new ApiError(409, "Session state changed; review the action again");
		const command = input.command;
		const reason = disabled(row, command.kind);
		if (reason) throw new ApiError(409, reason);
		if (command.kind === "dismiss") return this.runtime.dismiss(row);
		if (command.kind === "prompt" && command.text.trimStart().startsWith("/")) throw new ApiError(400, "Slash commands require desktop pi; use the typed mobile actions");
		if (command.kind === "prompt" && row.bridge!.phase === "working" && !command.deliverAs) throw new ApiError(400, "Choose steer or follow-up for a working session");
		await this.runtime.network.send(row, command);
	}
	/** The dashboard's new-session picker choices, in its order: this machine's, then those of each remote host that answers. */
	async projects(): Promise<{ projects: ProjectChoice[]; unreachable: { host: string; error: string }[] }> {
		const rows = this.runtime.store.ordered();
		const remotes = [...this.runtime.network.remotes.values()];
		const listed = await Promise.allSettled(remotes.map((remote) => remote.request("projects", { live: openCwds(hostRows(rows, remote.name)) })));
		const projects = choices(undefined, listProjects(this.runtime.sessionRoot, openCwds(hostRows(rows, undefined))));
		const unreachable: { host: string; error: string }[] = [];
		listed.forEach((result, index) => {
			const host = remotes[index].name;
			if (result.status === "fulfilled") projects.push(...choices(host, result.value));
			else unreachable.push({ host, error: clean(result.reason instanceof Error ? result.reason.message : String(result.reason)) ?? "" });
		});
		return { projects, unreachable };
	}
	private async project(id: string): Promise<ProjectChoice> {
		const project = (await this.projects()).projects.find((p) => p.id === id);
		if (!project) throw new ApiError(404, "Project no longer exists; refresh");
		return project;
	}
	/** Session files are paths on the project's host. */
	private async sessionsOf(project: ProjectChoice): Promise<SessionSummary[]> {
		if (project.host === null) return listSessions(this.runtime.sessionRoot, project.path, this.runtime.usage);
		return this.runtime.network.remote(project.host).request("sessions", { cwd: project.path });
	}
	async history(id: string) {
		const project = await this.project(id);
		const sessions = await this.sessionsOf(project);
		const rows = hostRows(this.runtime.store.ordered(), project.host ?? undefined);
		return sessions.slice(0, 200).map((s) => ({
			id: ref(s.path), title: clean(s.title, 200), lastActive: s.lastActive,
			blocked: resumeBlocked(rows, project.path, s.path) ?? null,
		}));
	}
	async launch(input: LaunchRequest): Promise<{ screen: string }> {
		const project = await this.project(input.projectId);
		const host = project.host ?? undefined;
		const file = input.sessionRef ? (await this.sessionsOf(project)).find((s) => ref(s.path) === input.sessionRef)?.path : undefined;
		if (input.sessionRef && !file) throw new ApiError(404, "Historical session no longer exists");
		const rows = hostRows(this.runtime.store.ordered(), host);
		const options = { cwd: project.path, label: project.label, sessionFile: file };
		let screen: string;
		if (host === undefined) {
			if (file) {
				const actual = realpathSync(file);
				const root = realpathSync(this.runtime.sessionRoot);
				const rel = relative(root, actual);
				if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new ApiError(403, "Session file escapes the session directory");
			}
			screen = launchSession(options, rows, this.runtime.runtimeDir);
		} else {
			// Give immediate feedback from this snapshot; the relay rechecks ownership on the host before launching.
			const blocked = file === undefined ? undefined : resumeBlocked(rows, project.path, file);
			if (blocked) throw new ApiError(409, blocked);
			screen = await this.runtime.network.remote(host).request("launch", options);
		}
		this.runtime.store.expectLaunch(screen, undefined, undefined, host);
		return { screen };
	}
}
