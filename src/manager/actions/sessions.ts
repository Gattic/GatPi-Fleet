// Project and session listings for the launcher and resume pickers.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type FileMeta, scanBuffer } from "../usage/extract.ts";
import type { UsageIndex } from "../usage/usage-index.ts";

const HEAD_CHUNK_BYTES = 64 * 1024;
/** Sessions can open with entries far larger than a chunk (the harness records its ~60 KB system prompt first); the first prompt follows. */
const HEAD_LIMIT_BYTES = 4 * 1024 * 1024;

/** pi's per-project session directory name. */
export function sessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** The start of a session file, read until `wanted` is known or the file's first `HEAD_LIMIT_BYTES` are exhausted. */
function readHead(path: string, wanted: "cwd" | "firstPrompt"): FileMeta {
	const meta: FileMeta = {};
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const chunk = Buffer.alloc(HEAD_CHUNK_BYTES);
		// The incomplete last line of a chunk is scanned with the next one.
		let pending = Buffer.alloc(0);
		let position = 0;
		while (meta[wanted] === undefined && position < HEAD_LIMIT_BYTES) {
			const read = readSync(fd, chunk, 0, HEAD_CHUNK_BYTES, position);
			if (read === 0) break;
			position += read;
			const data = Buffer.concat([pending, chunk.subarray(0, read)]);
			pending = data.subarray(scanBuffer(data, meta, []));
		}
	} catch {
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return meta;
}

export interface Project {
	cwd: string;
	/** Newest session file's mtime; 0 if pi has not written a session here yet. */
	lastActive: number;
	sessions: number;
}

export function listProjects(sessionRoot: string, liveCwds: readonly string[]): Project[] {
	const projects = new Map<string, Project>();
	let dirs: string[] = [];
	try {
		dirs = readdirSync(sessionRoot);
	} catch {}
	for (const dir of dirs) {
		const full = join(sessionRoot, dir);
		let files: { path: string; mtimeMs: number }[];
		try {
			files = readdirSync(full)
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => ({ path: join(full, name), mtimeMs: statSync(join(full, name)).mtimeMs }));
		} catch {
			continue;
		}
		if (!files.length) continue;
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const cwd = readHead(files[0].path, "cwd").cwd;
		if (!cwd || !existsSync(cwd)) continue;
		projects.set(cwd, { cwd, lastActive: files[0].mtimeMs, sessions: files.length });
	}
	for (const cwd of liveCwds) if (!projects.has(cwd)) projects.set(cwd, { cwd, lastActive: 0, sessions: 0 });
	const open = new Set(liveCwds);
	// Open projects first, then most recently active. The path breaks ties so the dashboard
	// and the gateway list identical inputs in the same order.
	return [...projects.values()].sort((a, b) => Number(open.has(b.cwd)) - Number(open.has(a.cwd)) || b.lastActive - a.lastActive || (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
}

export interface SessionSummary {
	path: string;
	sessionId?: string;
	title: string;
	lastActive: number;
	tokens?: number;
	cost?: number;
}

/** Titles and totals come from `index` when it has the file (it covers the retention window); otherwise the title is read from the file's start. */
export function listSessions(sessionRoot: string, cwd: string, index: UsageIndex): SessionSummary[] {
	const dir = join(sessionRoot, sessionDirName(cwd));
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {}
	const sessions: SessionSummary[] = [];
	for (const name of names) {
		const path = join(dir, name);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		const indexed = index.files.get(path);
		const head = indexed ? undefined : readHead(path, "firstPrompt");
		let tokens: number | undefined;
		let cost: number | undefined;
		if (indexed) {
			tokens = 0;
			cost = 0;
			for (const models of Object.values(indexed.hours)) {
				for (const bucket of Object.values(models)) {
					tokens += bucket.tokens;
					cost += bucket.cost;
				}
			}
		}
		const sessionName = indexed?.name ?? head?.name;
		const prompt = indexed?.firstPrompt ?? head?.firstPrompt;
		sessions.push({ path, sessionId: indexed?.sessionId ?? head?.sessionId, title: sessionName ?? prompt ?? "(empty session)", lastActive: mtimeMs, tokens, cost });
	}
	return sessions.sort((a, b) => b.lastActive - a.lastActive);
}
