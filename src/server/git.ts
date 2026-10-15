import { COMMIT_REVIEW_PROMPT, GitCli, gitDirtySummary, gitHeadLabel, isGitSummaryClean, type GitSummary } from "../manager/actions/git.ts";
import { UncertainCommandError } from "../manager/collectors/bridges.ts";
import { hostRows, rowCwd, rowLabel } from "../manager/model/store.ts";
import { RemoteGit } from "../manager/remote/git.ts";
import { ApiError, type GitRequest } from "./contract.ts";
import { clean, ref, revision, type Sessions } from "./sessions.ts";

/** Same choices as the TUI; descriptions are also the phone's confirmation text. */
export function gitMenu(summary: GitSummary, host: string | undefined, sessionRevision: string, working: string[]) {
	const head = gitHeadLabel(summary);
	const tree = gitDirtySummary(summary);
	const location = host ? `${host}:${summary.root}` : summary.root;
	const warning = working.length ? `\n\n${working.join(", ")} ${working.length === 1 ? "is" : "are"} working in this project. Let active tools finish before changing repository files or branches.` : "";
	const target = summary.upstream ?? `${summary.remotes[0]}/${summary.branch}`;
	const push = summary.upstream ? "git push" : `git push -u ${summary.remotes[0]} HEAD`;
	return {
		revision: ref(JSON.stringify([summary, host, sessionRevision, working])),
		location: clean(location, 2000), head: clean(head), branch: summary.branch ?? null, upstream: summary.upstream ?? null,
		pushRemote: !summary.upstream && summary.remotes.length === 1 ? summary.remotes[0] : null,
		ahead: summary.ahead, behind: summary.behind, tree, warning: clean(warning, 4000), commitPrompt: COMMIT_REVIEW_PROMPT,
		actions: [
			{ kind: "pull", label: "Update (pull --ff-only)", blocked: !summary.branch ? "Cannot pull from detached HEAD" : !summary.upstream ? "No upstream is configured; set one in git first" : null,
				description: clean(`Run git pull --ff-only in ${location} on ${head}?${isGitSummaryClean(summary) ? "" : `\n\nWorking tree is ${tree}; git may refuse if local changes overlap.`}${warning}`, 8000) },
			{ kind: "push", label: "Send (push)", blocked: !summary.branch ? "Cannot push from detached HEAD" : !summary.upstream && summary.remotes.length !== 1 ? "No upstream is configured; set one in git first" : null,
				description: clean(`Run ${push} in ${location} and publish ${head}${summary.ahead ? ` (${summary.ahead} ahead)` : ""} to ${target}?${summary.behind ? `\n\n${head} is behind ${target} by ${summary.behind}; push may be rejected until you pull.` : ""}`, 8000) },
			{ kind: "switch", label: "Switch branch", blocked: isGitSummaryClean(summary) ? null : "Working tree has changes; ask the agent to review, commit, or stash first", description: null },
		],
	};
}

/** Git can only address a currently listed session's directory, never a client-supplied path. */
export class SessionGit {
	private readonly local = new GitCli();
	private readonly sessions: Sessions;
	constructor(sessions: Sessions) { this.sessions = sessions; }
	private target(id: string) {
		const row = this.sessions.find(id);
		const cwd = rowCwd(row);
		if (!cwd) throw new ApiError(409, "Unknown project directory");
		const git = row.host === undefined ? this.local : new RemoteGit(this.sessions.runtime.network.remote(row.host));
		return { row, cwd, git };
	}
	private async checked<T>(action: () => Promise<T>): Promise<T> {
		try { return await action(); }
		catch (error) {
			if (error instanceof ApiError) throw error;
			const message = clean(error instanceof Error ? error.message : "Git operation failed")!;
			if (error instanceof UncertainCommandError) throw new UncertainCommandError(message);
			throw new ApiError(409, message);
		}
	}
	menu(id: string) { return this.checked(async () => {
		const { row, cwd, git } = this.target(id);
		const summary = await git.getSummary(cwd);
		const working = hostRows(this.sessions.runtime.store.ordered(), row.host)
			.filter((r) => r.exitedAt === undefined && rowCwd(r) === cwd && r.bridge?.phase === "working").map(rowLabel);
		return gitMenu(summary, row.host, revision(row), working);
	}); }
	branches(id: string) { return this.checked(async () => {
		const { cwd, git } = this.target(id);
		return { branches: (await git.listBranches(cwd)).slice(0, 1000).map((b) => ({ ...b, upstream: b.upstream ?? null })) };
	}); }
	status(id: string) { return this.checked(async () => {
		const { cwd, git } = this.target(id);
		return { text: clean(await git.status(cwd), 32_000) };
	}); }
	action(id: string, input: GitRequest) { return this.checked(async () => {
		const menu = await this.menu(id);
		if (menu.revision !== input.revision) throw new ApiError(409, "Git or session state changed; refresh and review the action again");
		const reason = menu.actions.find((a) => a.kind === input.action.kind)!.blocked;
		if (reason) throw new ApiError(409, reason);
		const { cwd, git } = this.target(id);
		switch (input.action.kind) {
			case "pull": await git.pull(cwd); break;
			case "push": {
				if (menu.upstream) await git.push(cwd);
				else await git.pushSetUpstream(cwd, menu.pushRemote!);
				break;
			}
			case "switch": {
				const branch = input.action.branch;
				if (!(await git.listBranches(cwd)).some((b) => b.name === branch && !b.current)) throw new ApiError(409, "Choose another existing local branch");
				await git.switchBranch(cwd, branch); break;
			}
		}
	}); }
}
