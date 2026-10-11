// The dashboard's Git shortcuts for a project on a remote host, run there by its relay.
import type { GitBranch, GitOperationResult, GitService, GitSummary } from "../actions/git.ts";
import type { GitMethod } from "../../relay/protocol.ts";
import type { RemoteHost } from "./host.ts";

/** Longer than GitCli's own network timeout, so the relay reports git's timeout rather than this one. */
const REMOTE_GIT_TIMEOUT_MS = 150_000;

export class RemoteGit implements GitService {
	private readonly host: RemoteHost;

	constructor(host: RemoteHost) {
		this.host = host;
	}

	getSummary(cwd: string): Promise<GitSummary> {
		return this.call("getSummary", cwd) as Promise<GitSummary>;
	}

	listBranches(cwd: string): Promise<GitBranch[]> {
		return this.call("listBranches", cwd) as Promise<GitBranch[]>;
	}

	status(cwd: string): Promise<string> {
		return this.call("status", cwd) as Promise<string>;
	}

	pull(cwd: string): Promise<GitOperationResult> {
		return this.call("pull", cwd) as Promise<GitOperationResult>;
	}

	push(cwd: string): Promise<GitOperationResult> {
		return this.call("push", cwd) as Promise<GitOperationResult>;
	}

	pushSetUpstream(cwd: string, remote: string): Promise<GitOperationResult> {
		return this.call("pushSetUpstream", cwd, remote) as Promise<GitOperationResult>;
	}

	switchBranch(cwd: string, branch: string): Promise<GitOperationResult> {
		return this.call("switchBranch", cwd, branch) as Promise<GitOperationResult>;
	}

	private call(method: GitMethod, ...args: string[]): Promise<unknown> {
		return this.host.request("git", { method, args }, REMOTE_GIT_TIMEOUT_MS);
	}
}
