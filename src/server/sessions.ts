import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { Command } from "../protocol/index.ts";
import { rowCwd, rowLabel, type SessionRow } from "../manager/model/store.ts";
import { isAlert } from "../manager/model/status.ts";
import { launchSession, resumeBlocked } from "../manager/actions/launch.ts";
import { listProjects, listSessions } from "../manager/actions/sessions.ts";
import type { ManagerRuntime } from "../manager/runtime.ts";
import { ApiError, type CommandRequest, type LaunchRequest } from "./contract.ts";

export const ref = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
export const clean = (text: string | undefined, max = 500): string | null => text === undefined ? null : stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, max);
export function sessionRef(row: SessionRow): string {
	return ref(row.bridge ? `${row.pid}:${row.bridge.sessionId}:${row.bridge.instanceId}` : `${row.pid}:proc:${row.proc?.startedAt ?? 0}`);
}
export function revision(row: SessionRow): string {
	return ref(JSON.stringify([sessionRef(row), row.bridge?.phase, row.bridge?.phaseSince, row.bridge?.lastSettledAt, row.bridge?.model, row.bridge?.thinking, row.exitedAt]));
}
export function disabled(row: SessionRow, kind: Command["kind"]): string | null {
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
		commands: Object.fromEntries((["prompt", "ask", "abort", "shutdown", "compact", "rename", "model", "thinking"] as const).map((kind) => [kind, disabled(row, kind)])),
	};
}

export class Sessions {
	readonly runtime: ManagerRuntime;
	readonly roots: string[];
	constructor(runtime: ManagerRuntime, roots: string[]) { this.runtime = runtime; this.roots = roots.map((root) => realpathSync(root)); }
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
			lastPrompt: clean(b?.lastPrompt, 200), lastSaid: clean(b?.lastSaid, 32_000), suggestion: clean(b?.suggestion, 2000),
			error: clean(b?.lastError?.message), models: b?.models.slice(0, 1000) ?? [],
			tools: b?.tools.slice(-20).map((t) => ({ name: clean(t.name, 100), detail: clean(t.detail, 100), startedAt: t.startedAt, endedAt: t.endedAt ?? null, isError: t.isError ?? false })) ?? [],
			asks: b?.asks.slice(-10).map((a) => ({ id: a.id, askedAt: a.askedAt, status: a.status, question: clean(a.question, 4000), answer: clean(a.answer, 32_000), error: clean(a.error), cost: a.usage?.cost ?? null })) ?? [],
		};
	}
	async command(id: string, input: CommandRequest): Promise<void> {
		const row = this.find(id);
		if (revision(row) !== input.revision) throw new ApiError(409, "Session state changed; review the action again");
		const reason = disabled(row, input.command.kind);
		if (reason) throw new ApiError(409, reason);
		if (input.command.kind === "prompt" && input.command.text.trimStart().startsWith("/")) throw new ApiError(400, "Slash commands require desktop pi; use the typed mobile actions");
		if (input.command.kind === "prompt" && row.bridge!.phase === "working" && !input.command.deliverAs) throw new ApiError(400, "Choose steer or follow-up for a working session");
		await this.runtime.hub.send(row.bridge!, input.command);
	}
	private approved(cwd: string): boolean {
		return this.roots.some((root) => { const rel = relative(root, cwd); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); });
	}
	projects() {
		const cwdList = [...this.roots, ...listProjects(this.runtime.sessionRoot, this.runtime.store.ordered().flatMap((r) => rowCwd(r) ?? [])).map((p) => p.cwd)];
		const canonical = new Set<string>();
		for (const cwd of cwdList) {
			try { const real = realpathSync(cwd); if (this.approved(real)) canonical.add(real); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		return [...canonical].sort().slice(0, 200).map((cwd) => ({ id: ref(cwd), label: basename(cwd), path: cwd }));
	}
	private project(id: string) {
		const project = this.projects().find((p) => p.id === id);
		if (!project) throw new ApiError(404, "Project is not approved or no longer exists");
		return project;
	}
	history(id: string) {
		const project = this.project(id);
		return listSessions(this.runtime.sessionRoot, project.path, this.runtime.usage).slice(0, 200).map((s) => ({
			id: ref(s.path), title: clean(s.title, 200), lastActive: s.lastActive,
			blocked: resumeBlocked(this.runtime.store.ordered(), project.path, s.path) ?? null,
		}));
	}
	launch(input: LaunchRequest): { screen: string } {
		const project = this.project(input.projectId);
		const file = input.sessionRef ? listSessions(this.runtime.sessionRoot, project.path, this.runtime.usage).find((s) => ref(s.path) === input.sessionRef)?.path : undefined;
		if (input.sessionRef && !file) throw new ApiError(404, "Historical session no longer exists");
		if (file) {
			const actual = realpathSync(file);
			const root = realpathSync(this.runtime.sessionRoot);
			const rel = relative(root, actual);
			if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new ApiError(403, "Session file escapes the session directory");
		}
		const screen = launchSession({ cwd: project.path, label: project.label, sessionFile: file }, this.runtime.store.ordered(), this.runtime.runtimeDir);
		this.runtime.store.expectLaunch(screen);
		return { screen };
	}
}
