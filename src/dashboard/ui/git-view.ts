// Git shortcut overlay for a selected project.
import { type Component, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { gitDirtySummary, gitHeadLabel, type GitSummary, isGitSummaryClean } from "../actions/git.ts";
import { shortPath } from "./format.ts";
import { frame } from "./overlays.ts";
import { keyHints, theme } from "./theme.ts";

export interface GitViewOptions {
	title: string;
	summary: () => GitSummary | undefined;
	loading: () => boolean;
	error: () => string | undefined;
	height: () => number;
	onPull: () => void;
	onPush: () => void;
	onSwitch: () => void;
	onCommitPrompt: () => void;
	onRefresh: () => void;
	onClose: () => void;
}

function divergence(summary: GitSummary): string {
	if (!summary.upstream) return "no upstream";
	const parts: string[] = [];
	if (summary.ahead) parts.push(`ahead ${summary.ahead}`);
	if (summary.behind) parts.push(`behind ${summary.behind}`);
	return parts.length ? parts.join(" / ") : "up to date";
}

function enabled(text: string): string {
	return theme.text(text);
}

/** Manual git actions for the selected row's project. */
export class GitView implements Component {
	private readonly options: GitViewOptions;

	constructor(options: GitViewOptions) {
		this.options = options;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "g") return this.options.onClose();
		if (data === "r") return this.options.onRefresh();
		if (data === "p") return this.options.onPull();
		if (data === "P") return this.options.onPush();
		if (data === "b") return this.options.onSwitch();
		if (data === "c") return this.options.onCommitPrompt();
	}

	render(width: number): string[] {
		const body: string[] = [];
		const loading = this.options.loading();
		const summary = this.options.summary();
		const error = this.options.error();
		if (loading) body.push(`${theme.working("◌")} ${theme.text("checking git…")}`);
		if (error) body.push(...wrapTextWithAnsi(theme.error(`✖ ${error}`), Math.max(1, width - 8)));
		if (summary) {
			const head = gitHeadLabel(summary);
			const upstream = summary.upstream ? ` → ${summary.upstream}` : "";
			body.push(`${theme.bold(theme.text(head))}${theme.dim(upstream)} ${theme.dim(`· ${divergence(summary)}`)}`);
			body.push(`${theme.dim("root")} ${theme.text(shortPath(summary.root))}`);
			body.push(`${theme.dim("tree")} ${isGitSummaryClean(summary) ? theme.working("clean") : theme.waiting(gitDirtySummary(summary))}`);
			if (!summary.upstream && summary.branch && summary.remotes.length === 1) body.push(theme.dim(`push will offer to create upstream ${summary.remotes[0]}/${summary.branch}`));
			body.push(
				"",
				`${theme.accent("p")} ${enabled("pull --ff-only")}   ${theme.accent("P")} ${enabled("push")}   ${theme.accent("b")} ${enabled("switch branch")}`,
				`${theme.accent("c")} ${enabled("ask AI to review/commit")}   ${theme.accent("r")} ${enabled("refresh")}`,
			);
		} else if (!loading) {
			body.push(theme.dim("No git status loaded. Press r to refresh."));
		}
		const shown = body.slice(0, Math.max(4, this.options.height() - 2));
		return frame(this.options.title, shown, width, keyHints([["p", "pull"], ["P", "push"], ["b", "branch"], ["c", "commit prompt"], ["r", "refresh"], ["Esc", "close"]]));
	}
}
