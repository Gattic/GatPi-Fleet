import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitCli, gitDirtySummary, gitHeadLabel, isGitSummaryClean, parseGitStatus } from "../src/dashboard/actions/git.ts";

test("parseGitStatus reads branch, divergence, and working tree counts", () => {
	const summary = parseGitStatus(
		`# branch.oid abcdef1234567890
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 old new src/staged.ts
1 .M N... 100644 100644 100644 old new src/changed.ts
? new-file.ts
u UU N... 100644 100644 100644 100644 a b c conflicted.ts
`,
		{ cwd: "/repo/sub", root: "/repo", remotes: ["origin"] },
	);

	assert.equal(summary.branch, "main");
	assert.equal(summary.upstream, "origin/main");
	assert.equal(summary.ahead, 2);
	assert.equal(summary.behind, 1);
	assert.equal(summary.staged, 1);
	assert.equal(summary.unstaged, 1);
	assert.equal(summary.untracked, 1);
	assert.equal(summary.conflicted, 1);
	assert.equal(isGitSummaryClean(summary), false);
	assert.equal(gitDirtySummary(summary), "1 staged, 1 changed, 1 untracked, 1 conflicted");
	assert.equal(gitHeadLabel(summary), "main");
});

test("parseGitStatus handles clean detached HEAD", () => {
	const summary = parseGitStatus(
		`# branch.oid abcdef1234567890
# branch.head (detached)
`,
		{ cwd: "/repo", root: "/repo", remotes: [] },
	);

	assert.equal(summary.branch, undefined);
	assert.equal(summary.detachedOid, "abcdef1234567890");
	assert.equal(isGitSummaryClean(summary), true);
	assert.equal(gitDirtySummary(summary), "clean");
	assert.equal(gitHeadLabel(summary), "detached abcdef123456");
});

test("parseGitStatus keeps detached HEAD oid even if status headers arrive out of order", () => {
	const summary = parseGitStatus(
		`# branch.head (detached)
# branch.oid fedcba9876543210
`,
		{ cwd: "/repo", root: "/repo", remotes: [] },
	);

	assert.equal(summary.branch, undefined);
	assert.equal(summary.detachedOid, "fedcba9876543210");
	assert.equal(gitHeadLabel(summary), "detached fedcba987654");
});

test("GitCli refuses to switch branches when the worktree became dirty", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-git-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

	git("init", "-b", "main");
	writeFileSync(join(repo, "file.txt"), "one\n");
	git("add", "file.txt");
	git("-c", "user.name=pi-dash", "-c", "user.email=pi-dash@example.invalid", "commit", "-m", "initial");
	git("switch", "-c", "feature");
	git("switch", "main");
	writeFileSync(join(repo, "file.txt"), "dirty\n");

	await assert.rejects(new GitCli().switchBranch(repo, "feature"), /Working tree has changes/);
});

test("GitCli reports why git failed: git's own error, a timeout, or too much output", async (t) => {
	const bin = mkdtempSync(join(tmpdir(), "pi-dash-fake-git-"));
	const path = process.env.PATH;
	t.after(() => {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
	});
	process.env.PATH = `${bin}:${path}`;
	const fakeGit = (script: string) => {
		writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
		chmodSync(join(bin, "git"), 0o755);
	};

	fakeGit('echo "fatal: not a git repository" >&2; exit 128');
	await assert.rejects(new GitCli().status(bin), { message: "fatal: not a git repository" });

	// A stopped command's partial output must not stand in for the reason it was stopped.
	fakeGit('echo "On branch main"; echo "warning: slow" >&2; exec sleep 5');
	await assert.rejects(new GitCli({ timeoutMs: 200 }).status(bin), { message: "git status timed out after 0.2s" });

	fakeGit("exec head -c 600000 /dev/zero");
	await assert.rejects(new GitCli().status(bin), { message: "git status printed more than 512 KB of output; run it in a terminal" });
});
