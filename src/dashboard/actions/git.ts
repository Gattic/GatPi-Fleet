// Git integration for the dashboard's project-management shortcuts.
import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 30_000;
const GIT_NETWORK_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT = 512 * 1024;

export interface GitSummary {
	cwd: string;
	root: string;
	branch?: string;
	detachedOid?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
	remotes: string[];
}

export interface GitBranch {
	name: string;
	current: boolean;
	upstream?: string;
}

export interface GitOperationResult {
	stdout: string;
	stderr: string;
}

export interface GitService {
	getSummary(cwd: string): Promise<GitSummary>;
	listBranches(cwd: string): Promise<GitBranch[]>;
	/** `git status` output as git prints it. */
	status(cwd: string): Promise<string>;
	pull(cwd: string): Promise<GitOperationResult>;
	push(cwd: string): Promise<GitOperationResult>;
	pushSetUpstream(cwd: string, remote: string): Promise<GitOperationResult>;
	switchBranch(cwd: string, branch: string): Promise<GitOperationResult>;
}

export class GitCommandError extends Error {
	readonly stdout: string;
	readonly stderr: string;

	constructor(args: readonly string[], stdout: string, stderr: string, fallback: string) {
		const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
		super(output || fallback || `git ${args.join(" ")} failed`);
		this.name = "GitCommandError";
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

interface ParseStatusOptions {
	cwd: string;
	root: string;
	remotes: string[];
}

export function isGitSummaryClean(summary: GitSummary): boolean {
	return summary.staged + summary.unstaged + summary.untracked + summary.conflicted === 0;
}

export function gitHeadLabel(summary: GitSummary): string {
	return summary.branch ?? (summary.detachedOid ? `detached ${summary.detachedOid.slice(0, 12)}` : "unknown HEAD");
}

export function gitDirtySummary(summary: GitSummary): string {
	if (isGitSummaryClean(summary)) return "clean";
	const parts: string[] = [];
	if (summary.staged) parts.push(`${summary.staged} staged`);
	if (summary.unstaged) parts.push(`${summary.unstaged} changed`);
	if (summary.untracked) parts.push(`${summary.untracked} untracked`);
	if (summary.conflicted) parts.push(`${summary.conflicted} conflicted`);
	return parts.join(", ");
}

export function parseGitStatus(output: string, options: ParseStatusOptions): GitSummary {
	const summary: GitSummary = {
		cwd: options.cwd,
		root: options.root,
		ahead: 0,
		behind: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflicted: 0,
		remotes: options.remotes,
	};
	let oid: string | undefined;
	let detached = false;
	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("# ")) {
			if (line.startsWith("# branch.oid ")) {
				oid = line.slice("# branch.oid ".length).trim();
				if (detached && oid !== "(initial)") summary.detachedOid = oid;
			} else if (line.startsWith("# branch.head ")) {
				const head = line.slice("# branch.head ".length).trim();
				if (head === "(detached)") {
					detached = true;
					summary.detachedOid = oid && oid !== "(initial)" ? oid : undefined;
				} else summary.branch = head;
			} else if (line.startsWith("# branch.upstream ")) {
				summary.upstream = line.slice("# branch.upstream ".length).trim();
			} else {
				const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
				if (match) {
					summary.ahead = Number(match[1]);
					summary.behind = Number(match[2]);
				}
			}
			continue;
		}
		if (line.startsWith("? ")) {
			summary.untracked++;
			continue;
		}
		if (line.startsWith("u ")) {
			summary.conflicted++;
			continue;
		}
		if ((line.startsWith("1 ") || line.startsWith("2 ")) && line.length >= 4) {
			const staged = line[2];
			const unstaged = line[3];
			if (staged && staged !== ".") summary.staged++;
			if (unstaged && unstaged !== ".") summary.unstaged++;
		}
	}
	return summary;
}

function parseRemotes(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
}

function runGit(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitOperationResult> {
	const gitArgs = ["-C", cwd, "-c", "color.ui=false", "-c", "core.pager=cat", ...args];
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			gitArgs,
			{
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", NO_COLOR: "1" },
				encoding: "utf8",
				maxBuffer: MAX_GIT_OUTPUT,
				timeout: timeoutMs,
			},
			(error, stdout, stderr) => {
				if (error) reject(new GitCommandError(args, stdout, stderr, error.message));
				else resolve({ stdout, stderr });
			},
		);
	});
}

export class GitCli implements GitService {
	async getSummary(cwd: string): Promise<GitSummary> {
		const [root, status, remotes] = await Promise.all([
			runGit(cwd, ["rev-parse", "--show-toplevel"]),
			runGit(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]),
			runGit(cwd, ["remote"]),
		]);
		return parseGitStatus(status.stdout, { cwd, root: root.stdout.trim(), remotes: parseRemotes(remotes.stdout) });
	}

	async listBranches(cwd: string): Promise<GitBranch[]> {
		const { stdout } = await runGit(cwd, ["for-each-ref", "--sort=refname:short", "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)", "refs/heads"]);
		return stdout
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				const [name = "", head = "", upstream = ""] = line.split("\0");
				return { name, current: head.trim() === "*", upstream: upstream || undefined };
			})
			.filter((branch) => branch.name);
	}

	async status(cwd: string): Promise<string> {
		return (await runGit(cwd, ["status"])).stdout;
	}

	pull(cwd: string): Promise<GitOperationResult> {
		return runGit(cwd, ["pull", "--ff-only"], GIT_NETWORK_TIMEOUT_MS);
	}

	push(cwd: string): Promise<GitOperationResult> {
		return runGit(cwd, ["push"], GIT_NETWORK_TIMEOUT_MS);
	}

	pushSetUpstream(cwd: string, remote: string): Promise<GitOperationResult> {
		return runGit(cwd, ["push", "-u", remote, "HEAD"], GIT_NETWORK_TIMEOUT_MS);
	}

	async switchBranch(cwd: string, branch: string): Promise<GitOperationResult> {
		const summary = await this.getSummary(cwd);
		if (!isGitSummaryClean(summary)) throw new Error("Working tree has changes; ask the agent to review, commit, or stash first");
		return runGit(cwd, ["switch", "--", branch]);
	}
}
