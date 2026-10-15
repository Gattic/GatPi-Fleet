import { gitMenu } from "../src/server/git.ts";

export function gitFixture() {
	return { epoch: "00000000-0000-4000-8000-000000000000", ...gitMenu({
		cwd: "/project", root: "/project", branch: "main", headOid: "a".repeat(40), upstream: "origin/main",
		ahead: 2, behind: 1, staged: 1, unstaged: 2, untracked: 3, conflicted: 0, remotes: ["origin"],
	}, "box", "session-revision", ["project@box"]) };
}
