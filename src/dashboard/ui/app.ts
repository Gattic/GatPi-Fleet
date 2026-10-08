// Root component: owns the current view, selection, overlays and user actions.
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Component, Key, matchesKey, type OverlayHandle, type OverlayOptions, type SelectItem, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { type Command, THINKING_LEVELS, type DeliverAs } from "../../protocol/index.ts";
import { gitDirtySummary, gitHeadLabel, type GitBranch, type GitOperationResult, type GitService, type GitSummary, isGitSummaryClean } from "../../manager/actions/git.ts";
import { attachSession, readHardcopy, requestHardcopy } from "../actions/screen.ts";
import { launchSession, resumeBlocked } from "../../manager/actions/launch.ts";
import { listProjects, listSessions } from "../../manager/actions/sessions.ts";
import type { BridgeHub } from "../../manager/collectors/bridges.ts";
import type { GpuMonitor } from "../../manager/collectors/gpu.ts";
import { buildHermesSnapshot, feedbackFor, type HermesAdviceCard, type HermesAdvisorClient, type HermesCardAction } from "../hermes/advisor.ts";
import type { QuotaMonitor } from "../../manager/collectors/quota.ts";
import { isAlert } from "../../manager/model/status.ts";
import { openCwds, rowCwd, rowLabel, rowSty, rowWindow, type SessionRow, type Store } from "../../manager/model/store.ts";
import type { UsageIndex } from "../../manager/usage/usage-index.ts";
import { fmtCost, fmtDuration, fmtTokens, shortPath } from "./format.ts";
import { AskView, Composer, Confirm, Help, HermesAdviceView, Peek, Picker, Reader, TextPrompt } from "./overlays.ts";
import { TextPane } from "./text-pane.ts";
import { keyHints, theme } from "./theme.ts";
import { GitView } from "./git-view.ts";
import { type DetailView, renderDetail } from "./views/detail.ts";
import { renderOverview } from "./views/overview.ts";
import { background, SPINNER, type ViewContext, type ViewName } from "./views/shared.ts";
import { renderUsage, USAGE_RANGES, type UsageMetric, type UsageRange } from "./views/usage.ts";

export interface Services {
	tui: TUI;
	store: Store;
	hub: BridgeHub;
	usage: UsageIndex;
	quota: QuotaMonitor;
	gpu: GpuMonitor;
	advisor: HermesAdvisorClient;
	git: GitService;
	sessionRoot: string;
	/** Private runtime directory for transient files (peek captures). */
	runtimeDir: string;
	quit: () => void;
}

const FLASH_MS = 5000;
const PEEK_REFRESH_MS = 1000;
const GIT_MESSAGE_LIMIT = 500;

export const COMMIT_REVIEW_PROMPT = "Review the current git changes. If everything looks good, create a focused commit with an appropriate message; otherwise explain what needs attention. Do not push.";

const KEYS: Record<ViewName, [string, string][]> = {
	overview: [["1-9", "select"], ["Tab", "next ◆"], ["⏎", "detail"], ["p", "prompt"], ["i", "ask"], ["H", "Hermes"], ["g", "git"], ["x", "abort"], ["s", "said"], ["v", "peek"], ["a", "attach"], ["n", "new"], ["r", "resume"], ["c", "close"], ["u", "usage"], ["?", "help"], ["q", "quit"]],
	detail: [["Esc", "back"], ["Tab", "next ◆"], ["p", "prompt"], ["i", "ask"], ["H", "Hermes"], ["g", "git"], ["x", "abort"], ["s", "read said"], ["PgUp/PgDn", "scroll said"], ["v", "peek"], ["a", "attach"], ["M", "model"], ["T", "thinking"], ["Z", "compact"], ["c", "close"], ["R", "rename"], ["?", "help"]],
	usage: [["Esc", "back"], ["t", "today"], ["w", "7 days"], ["m", "30 days"], ["$", "cost/tokens"], ["?", "help"]],
};

export class App implements Component {
	private view: ViewName = "overview";
	private selectedPid?: number;
	// A recycled or resumed session replaces its row in the same slot; selection follows it.
	private selectedSlot?: number;
	private range: UsageRange = "today";
	private metric: UsageMetric = "cost";
	private flash?: { text: string; error: boolean; until: number };
	private spinnerIndex = 0;
	private overlay?: OverlayHandle;
	private peekTimer?: NodeJS.Timeout;
	private peekFile?: string;
	private readonly recycles = new Map<number, { cwd: string; label: string }>();
	// Asks sent from here that are still answering (pid → ask id), and the session whose ask view is open.
	private readonly awaitingAnswer = new Map<number, number>();
	private askViewPid?: number;
	// The detail view's SAID pane: scroll position, and where it was last drawn (for the mouse).
	private readonly said = new TextPane();
	private saidArea: DetailView["said"];
	private attached = false;
	private readonly services: Services;

	constructor(services: Services) {
		this.services = services;
	}

	invalidate(): void {}

	get isAttached(): boolean {
		return this.attached;
	}

	/** Advance spinners; returns true when something is animating. */
	advanceSpinner(): boolean {
		this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER.length;
		return this.services.store.ordered().some((row) => row.status.kind === "working");
	}

	/** Periodic housekeeping: launch replacement sessions for closed recycles; report answers that arrive unseen. */
	onTick(): void {
		for (const [pid, recycle] of this.recycles) {
			const row = this.services.store.rows.get(pid);
			if (row && row.exitedAt === undefined) continue;
			this.recycles.delete(pid);
			this.launch(recycle.cwd, recycle.label, undefined, row);
		}
		for (const [pid, id] of this.awaitingAnswer) {
			const row = this.services.store.rows.get(pid);
			const ask = row?.bridge?.asks.find((run) => run.id === id);
			if (ask?.status === "answering") continue;
			this.awaitingAnswer.delete(pid);
			if (!row || !ask || this.askViewPid === pid) continue;
			if (ask.status === "answered") this.notify(`${rowLabel(row)} answered your question (i to read it)`);
			else this.notify(`${rowLabel(row)} could not answer: ${ask.error ?? "failed"}`, true);
		}
	}

	private selected(): SessionRow | undefined {
		const rows = this.services.store.ordered();
		const current = rows.find((row) => row.pid === this.selectedPid) ?? rows.find((row) => row.slot !== undefined && row.slot === this.selectedSlot) ?? rows[0];
		this.selectedPid = current?.pid;
		this.selectedSlot = current?.slot;
		return current;
	}

	private select(row: SessionRow | undefined): void {
		if (!row) return;
		this.selectedPid = row.pid;
		this.selectedSlot = row.slot;
		this.services.store.acknowledge(row.pid);
	}

	render(width: number): string[] {
		const height = Math.max(5, this.services.tui.terminal.rows);
		const now = Date.now();
		const ctx: ViewContext = {
			store: this.services.store,
			usage: this.services.usage,
			quota: this.services.quota,
			gpu: this.services.gpu,
			now,
			spinner: SPINNER[this.spinnerIndex],
			selected: this.selected(),
		};
		const detail = this.view === "detail" ? renderDetail(ctx, width, height, this.said) : undefined;
		this.saidArea = detail?.said;
		const body = detail ? detail.lines : this.view === "usage" ? renderUsage(ctx, width, height, this.range, this.metric) : renderOverview(ctx, width, height);
		while (body.length < height - 1) body.push("");
		const lines = [...body, this.footer(width, now)];
		// Dialogs sit on a dimmed copy of the view.
		return this.overlay ? lines.map((line) => theme.faint(stripTerminalSequences(line))) : lines;
	}

	private footer(width: number, now: number): string {
		if (this.flash && this.flash.until > now) {
			const text = this.flash.error ? theme.error(`✖ ${this.flash.text}`) : `${theme.working("✓")} ${theme.text(this.flash.text)}`;
			return background(` ${text}`, width, theme.bar);
		}
		// Drop hints from the end, but always keep help reachable.
		const keys = KEYS[this.view];
		const help = keys.find(([key]) => key === "?");
		const text = (list: [string, string][]) => ` ${keyHints(list)}`;
		let shown = keys;
		while (shown.length > 1 && visibleWidth(text(shown)) > width) {
			shown = [...shown.filter(([key]) => key !== "?").slice(0, -1), ...(help ? [help] : [])];
		}
		return background(text(shown), width, theme.bar);
	}

	private notify(text: string, error = false): void {
		this.flash = { text, error, until: Date.now() + FLASH_MS };
		this.services.tui.requestRender();
	}

	handleInput(data: string): void {
		const store = this.services.store;
		if (matchesKey(data, Key.ctrl("c")) || data === "q") return this.requestQuit();
		if (data === "?") return this.showHelp();
		if (data === "H") return this.openHermes();
		if (/^[1-9]$/.test(data)) {
			this.select(store.bySlot(Number(data)));
		} else if (matchesKey(data, Key.tab)) {
			this.selectNextAttention();
		} else if (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.down) || data === "j") {
			const rows = store.ordered();
			const index = rows.findIndex((row) => row.pid === this.selected()?.pid);
			const delta = matchesKey(data, Key.up) || data === "k" ? -1 : 1;
			this.select(rows[Math.max(0, Math.min(rows.length - 1, index + delta))]);
		} else if (matchesKey(data, Key.enter)) {
			this.view = this.view === "detail" ? "overview" : "detail";
		} else if (matchesKey(data, Key.escape)) {
			this.view = "overview";
		} else if (data === "u") {
			this.view = this.view === "usage" ? "overview" : "usage";
		} else if (this.view === "usage" && (data === "t" || data === "w" || data === "m")) {
			this.range = data === "t" ? "today" : data === "w" ? "7d" : "30d";
		} else if (this.view === "usage" && data === "$") {
			this.metric = this.metric === "cost" ? "tokens" : "cost";
		} else if (this.view === "detail" && (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown))) {
			this.said.page(matchesKey(data, Key.pageUp) ? -1 : 1);
		} else if (this.view === "usage" && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
			const index = USAGE_RANGES.indexOf(this.range) + (matchesKey(data, Key.left) ? -1 : 1);
			this.range = USAGE_RANGES[(index + USAGE_RANGES.length) % USAGE_RANGES.length];
		} else if (data === "n") {
			this.pickProject("New session in…", (cwd) => this.launch(cwd, basename(cwd)));
		} else {
			const row = this.selected();
			if (!row) {
				if ("gpixsvacCRrdMTZ".includes(data)) this.notify("No session selected", true);
				return;
			}
			this.rowAction(row, data);
		}
		this.services.tui.requestRender();
	}

	/** Sessions that need attention (needs you, error, stalled), longest waiting first; each press selects the next one. */
	private selectNextAttention(): void {
		const candidates = this.services.store
			.ordered()
			.filter((row) => isAlert(row.status.kind))
			.sort((a, b) => (a.status.since ?? Number.POSITIVE_INFINITY) - (b.status.since ?? Number.POSITIVE_INFINITY));
		if (!candidates.length) return this.notify("No session needs you");
		const current = candidates.findIndex((row) => row.pid === this.selected()?.pid);
		this.select(candidates[(current + 1) % candidates.length]);
	}

	/** Over the detail view's SAID text: the wheel scrolls it, a click opens the reader. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const area = this.saidArea;
		if (this.overlay || !area || event.y < area.top || event.y >= area.top + area.height) return undefined;
		if (event.type === "wheel") {
			this.said.scrollBy(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (event.button !== "left") return undefined;
		// Claiming the press is what makes its release arrive here as a click.
		if (event.type === "press") return { handled: true, render: false };
		if (event.type === "click") {
			const row = this.selected();
			if (row) this.openReader(row);
			return { handled: true };
		}
		return undefined;
	}

	private rowAction(row: SessionRow, key: string): void {
		// An action overlay retains the identity it showed, even if the live row switches.
		row = { ...row };
		const label = rowLabel(row);
		switch (key) {
			case "p":
				return this.compose(row);
			case "i":
				return this.openAsk(row);
			case "g":
				return this.openGit(row);
			case "x":
				if (row.status.kind !== "working" && row.status.kind !== "stalled" && row.status.kind !== "rate-limited") return this.notify(`${label} is not working`, true);
				return this.confirm("Abort", `Abort the current run of ${label}?`, () => this.send(row, { kind: "abort" }, `aborted ${label}`));
			case "s":
				return this.openReader(row);
			case "v":
				return this.openPeek(row);
			case "a":
				void this.attach(row);
				return;
			case "c":
				return this.confirmClose(row, false);
			case "C":
				return this.confirmClose(row, true);
			case "R":
				if (!this.requireBridge(row)) return;
				return this.show(
					new TextPrompt(`Rename ${label}`, row.bridge?.name ?? "", (name) => {
						this.closeOverlay();
						this.send(row, { kind: "rename", name }, `renamed to ${name}`);
					}, () => this.closeOverlay()),
				);
			case "r":
				return this.pickSession(row);
			case "d":
				if (row.exitedAt === undefined) return this.notify("Only exited sessions can be dismissed", true);
				this.services.store.dismiss(row.pid);
				return;
			case "M":
				return this.pickModel(row);
			case "T":
				return this.pickThinking(row);
			case "Z": {
				if (!this.requireBridge(row)) return;
				if (row.bridge?.phase === "working") return this.notify(`${label} is working; compact it when it is idle`, true);
				const percent = row.bridge?.context?.percent;
				const full = percent != null ? ` Its context is ${Math.round(percent)}% full.` : "";
				return this.confirm("Compact", `Compact ${label} now?${full} pi summarizes the conversation so far with the session's model.`, () => this.send(row, { kind: "compact" }, `compacting ${label}`));
			}
		}
	}

	private pickModel(row: SessionRow): void {
		if (!this.requireBridge(row)) return;
		const current = row.bridge?.model;
		const items: SelectItem[] = (row.bridge?.models ?? []).map((model) => {
			const slash = model.indexOf("/");
			return { value: model, label: model.slice(slash + 1), description: `${model.slice(0, slash)}${model === current ? " · current" : ""}` };
		});
		if (!items.length) return this.notify(`${rowLabel(row)} reports no models it can switch to`, true);
		this.show(
			new Picker({
				title: `Model for ${rowLabel(row)}`,
				items,
				onSelect: (item) => {
					this.closeOverlay();
					const slash = item.value.indexOf("/");
					this.send(row, { kind: "model", provider: item.value.slice(0, slash), id: item.value.slice(slash + 1) }, `${rowLabel(row)} now uses ${item.label}`);
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private pickThinking(row: SessionRow): void {
		if (!this.requireBridge(row)) return;
		const current = row.bridge?.thinking;
		const items: SelectItem[] = THINKING_LEVELS.map((level) => ({ value: level, label: level, description: level === current ? "current" : "" }));
		this.show(
			new Picker({
				title: `Thinking level for ${rowLabel(row)} (pi limits it to what the model supports)`,
				items,
				onSelect: (item) => {
					this.closeOverlay();
					const level = THINKING_LEVELS.find((option) => option === item.value);
					if (level) this.send(row, { kind: "thinking", level }, `thinking level ${level} requested for ${rowLabel(row)}`);
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private requireBridge(row: SessionRow): boolean {
		if (row.exitedAt !== undefined) {
			this.notify(`${rowLabel(row)} has exited (r resumes it)`, true);
			return false;
		}
		if (!row.bridge || !this.services.hub.isConnected(row.pid)) {
			this.notify(`${rowLabel(row)} has no bridge connection (started before pi-dash was installed?)`, true);
			return false;
		}
		return true;
	}

	private send(row: SessionRow, command: Command, success: string): void {
		this.services.hub.send(row.bridge!, command).then(
			() => this.notify(success),
			(error: Error) => this.notify(`${rowLabel(row)}: ${error.message}`, true),
		);
	}

	private show(component: Component, options: OverlayOptions = {}): void {
		this.overlay?.hide();
		this.overlay = this.services.tui.showOverlay(component, { width: "70%", minWidth: 60, maxHeight: "85%", anchor: "center", ...options });
		this.services.tui.requestRender();
	}

	private closeOverlay(): void {
		this.overlay?.hide();
		this.overlay = undefined;
		this.askViewPid = undefined;
		if (this.peekTimer) clearInterval(this.peekTimer);
		this.peekTimer = undefined;
		if (this.peekFile) {
			try {
				unlinkSync(this.peekFile);
			} catch {}
			this.peekFile = undefined;
		}
		this.services.tui.setFocus(this);
		this.services.tui.requestRender();
	}

	private showHelp(): void {
		this.show(new Help(() => this.closeOverlay()), { width: "80%", minWidth: 96 });
	}

	private confirm(title: string, message: string, onYes: () => void): void {
		this.show(
			new Confirm(title, message, (yes) => {
				this.closeOverlay();
				if (yes) onYes();
			}),
			{ width: 64 },
		);
	}

	private openGit(row: SessionRow): void {
		const cwd = rowCwd(row);
		if (!cwd) return this.notify("Unknown project directory", true);
		let summary: GitSummary | undefined;
		let loading = false;
		let error: string | undefined;
		const refresh = () => {
			if (loading) return;
			loading = true;
			error = undefined;
			this.services.tui.requestRender();
			this.services.git.getSummary(cwd).then(
				(result) => {
					summary = result;
					loading = false;
					this.services.tui.requestRender();
				},
				(failure: Error) => {
					loading = false;
					error = this.gitMessage(failure);
					this.services.tui.requestRender();
				},
			);
		};
		this.show(
			new GitView({
				title: `Git · ${rowLabel(row)}`,
				summary: () => summary,
				loading: () => loading,
				error: () => error,
				height: () => this.services.tui.terminal.rows,
				onPull: () => this.confirmGitPull(cwd, summary),
				onPush: () => this.confirmGitPush(cwd, summary),
				onSwitch: () => void this.pickGitBranch(row, cwd, summary),
				onStatus: () => void this.showGitStatus(row, cwd),
				onCommitPrompt: () => this.openCommitPrompt(row, summary),
				onRefresh: refresh,
				onClose: () => this.closeOverlay(),
			}),
			{ width: "80%", maxHeight: "85%" },
		);
		refresh();
	}

	private confirmGitPull(cwd: string, summary: GitSummary | undefined): void {
		if (!summary) return this.notify("Git status has not loaded yet", true);
		if (!summary.branch) return this.notify("Cannot pull from detached HEAD", true);
		if (!summary.upstream) return this.notify("No upstream is configured; set one in git first", true);
		const dirty = isGitSummaryClean(summary) ? "" : `\n\nWorking tree is ${gitDirtySummary(summary)}; git may refuse if local changes overlap.`;
		const message = `Run git pull --ff-only in ${shortPath(summary.root)} on ${gitHeadLabel(summary)}?${dirty}${this.workingSessionWarning(cwd)}`;
		this.confirm("Git pull", message, () => this.runGitAction(() => this.services.git.pull(cwd), `pulled ${gitHeadLabel(summary)}`));
	}

	private confirmGitPush(cwd: string, summary: GitSummary | undefined): void {
		if (!summary) return this.notify("Git status has not loaded yet", true);
		if (!summary.branch) return this.notify("Cannot push from detached HEAD", true);
		let action: () => Promise<GitOperationResult>;
		let command: string;
		let target: string;
		if (summary.upstream) {
			action = () => this.services.git.push(cwd);
			command = "git push";
			target = summary.upstream;
		} else {
			if (summary.remotes.length !== 1) return this.notify("No upstream is configured; set one in git first", true);
			const remote = summary.remotes[0];
			action = () => this.services.git.pushSetUpstream(cwd, remote);
			command = `git push -u ${remote} HEAD`;
			target = `${remote}/${summary.branch}`;
		}
		const behind = summary.behind ? `\n\n${gitHeadLabel(summary)} is behind ${summary.upstream ?? target} by ${summary.behind}; push may be rejected until you pull.` : "";
		const ahead = summary.ahead ? ` (${summary.ahead} ahead)` : "";
		this.confirm("Git push", `Run ${command} and publish ${gitHeadLabel(summary)}${ahead} to ${target}?${behind}`, () => this.runGitAction(action, `pushed ${gitHeadLabel(summary)}`));
	}

	private async pickGitBranch(row: SessionRow, cwd: string, summary: GitSummary | undefined): Promise<void> {
		if (!summary) return this.notify("Git status has not loaded yet", true);
		if (!isGitSummaryClean(summary)) return this.notify("Working tree has changes; ask the agent to review, commit, or stash first", true);
		const menu = this.overlay;
		let branches: GitBranch[];
		try {
			branches = await this.services.git.listBranches(cwd);
		} catch (error) {
			this.notify(this.gitMessage(error as Error), true);
			return;
		}
		// As with git status: a picker opening late would replace whatever the user moved on to.
		if (this.overlay !== menu) return;
		if (!branches.length) return this.notify("No local branches found", true);
		const items: SelectItem[] = branches.map((branch) => ({
			value: branch.name,
			label: branch.name,
			description: [branch.current ? "current" : undefined, branch.upstream ? `tracks ${branch.upstream}` : undefined].filter(Boolean).join(" · "),
		}));
		this.show(
			new Picker({
				title: `Switch branch in ${shortPath(summary.root)}`,
				items,
				onSelect: (item) => {
					if (item.value === summary.branch) {
						this.notify(`${item.label} is already checked out`);
						return;
					}
					const message = `Switch ${rowLabel(row)} from ${gitHeadLabel(summary)} to ${item.value}?${this.workingSessionWarning(cwd)}`;
					this.confirm("Switch branch", message, () => this.runGitAction(() => this.services.git.switchBranch(cwd, item.value), `switched ${rowLabel(row)} to ${item.value}`));
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private async showGitStatus(row: SessionRow, cwd: string): Promise<void> {
		const menu = this.overlay;
		let output: string;
		try {
			output = await this.services.git.status(cwd);
		} catch (error) {
			this.notify(this.gitMessage(error as Error), true);
			return;
		}
		// git status can be slow; if the user left the Git menu meanwhile, opening the view would replace
		// whatever they moved on to (a half-typed prompt, a confirmation).
		if (this.overlay !== menu) return;
		this.show(
			new Reader({
				title: `git status · ${rowLabel(row)}`,
				text: () => output,
				plain: true,
				height: () => this.services.tui.terminal.rows,
				keys: [["Esc", "close"]],
				onKey: (data) => {
					if (matchesKey(data, Key.escape) || data === "v" || data === "q") this.closeOverlay();
				},
			}),
			{ width: "100%", maxHeight: "100%" },
		);
	}

	private openCommitPrompt(row: SessionRow, summary: GitSummary | undefined): void {
		if (!summary) return this.notify("Git status has not loaded yet", true);
		if (!this.requireBridge(row)) return;
		this.compose(row, COMMIT_REVIEW_PROMPT, row.bridge?.phase === "working" ? "followUp" : "steer");
	}

	private runGitAction(action: () => Promise<GitOperationResult>, success: string): void {
		action().then(
			(result) => this.notify(this.gitOperationMessage(success, result)),
			(error: Error) => this.notify(this.gitMessage(error), true),
		);
	}

	private gitOperationMessage(success: string, result: GitOperationResult): string {
		const detail = [...result.stderr.split(/\r?\n/), ...result.stdout.split(/\r?\n/)].map((line) => line.trim()).find(Boolean);
		return detail ? this.clipMessage(`${success}: ${detail}`) : success;
	}

	private gitMessage(error: Error): string {
		return this.clipMessage(error.message || "git command failed");
	}

	private clipMessage(message: string): string {
		const compact = message.replace(/\s+/g, " ").trim();
		return compact.length > GIT_MESSAGE_LIMIT ? `${compact.slice(0, GIT_MESSAGE_LIMIT - 1)}…` : compact;
	}

	private workingSessionWarning(cwd: string): string {
		const working = this.services.store
			.ordered()
			.filter((row) => row.exitedAt === undefined && rowCwd(row) === cwd && row.bridge?.phase === "working")
			.map((row) => rowLabel(row));
		if (!working.length) return "";
		return `\n\n${working.join(", ")} ${working.length === 1 ? "is" : "are"} working in this project. Let active tools finish before changing repository files or branches.`;
	}

	/** Pending recycles live only in this process, so quitting drops their replacement launch. */
	private requestQuit(): void {
		const pending = [...this.recycles.values()].map((recycle) => recycle.label);
		if (!pending.length) return this.services.quit();
		const message = `Close-and-restart is still pending for ${pending.join(", ")}. If pi-dash quits now, ${pending.length === 1 ? "that session still closes" : "those sessions still close"} but no new session starts. Quit anyway?`;
		this.confirm("Quit", message, () => this.services.quit());
	}

	private compose(row: SessionRow, initialText = "", initialMode: DeliverAs = "steer"): void {
		if (!this.requireBridge(row)) return;
		const store = this.services.store;
		this.show(
			new Composer(this.services.tui, {
				target: `${row.slot ?? "·"} ${rowLabel(row)}`,
				isWorking: () => store.rows.get(row.pid)?.bridge?.phase === "working",
				suggestion: () => store.rows.get(row.pid)?.bridge?.suggestion,
				initialText,
				initialMode,
				onSubmit: (text, deliverAs) => {
					this.closeOverlay();
					const working = store.rows.get(row.pid)?.bridge?.phase === "working";
					this.send(row, { kind: "prompt", text, deliverAs: working ? deliverAs : undefined }, working ? `queued as ${deliverAs === "steer" ? "steer" : "follow-up"} for ${rowLabel(row)}` : `sent to ${rowLabel(row)}`);
				},
				onCancel: () => this.closeOverlay(),
			}),
			{ width: "80%", maxHeight: "60%" },
		);
	}

	private openAsk(row: SessionRow): void {
		if (!this.requireBridge(row)) return;
		const { store, hub, tui } = this.services;
		this.show(
			new AskView(tui, {
				target: `${row.slot ?? "·"} ${rowLabel(row)}`,
				asks: () => store.rows.get(row.pid)?.bridge?.asks ?? [],
				height: () => tui.terminal.rows,
				onAsk: (question) =>
					hub
						.send(row.bridge!, { kind: "ask", question })
						.then(() => {
							// The bridge sends the new ask before its ack.
							const id = store.rows.get(row.pid)?.bridge?.asks.at(-1)?.id;
							if (id !== undefined) this.awaitingAnswer.set(row.pid, id);
						})
						.finally(() => tui.requestRender()),
				onClose: () => this.closeOverlay(),
			}),
			{ width: "100%", maxHeight: "100%" },
		);
		// After show(), which closes any earlier overlay.
		this.askViewPid = row.pid;
	}

	private openHermes(): void {
		let review: Awaited<ReturnType<HermesAdvisorClient["review"]>> | undefined;
		let loading = false;
		let error: string | undefined;
		const refresh = () => {
			if (loading) return;
			loading = true;
			error = undefined;
			this.services.tui.requestRender();
			const snapshot = buildHermesSnapshot(this.services.store);
			this.services.advisor.review(snapshot).then(
				(result) => {
					review = result;
					loading = false;
					error = result.error;
					for (const card of result.cards) void this.services.advisor.recordFeedback(feedbackFor(card, "shown", result.error));
					this.services.tui.requestRender();
				},
				(failure: Error) => {
					loading = false;
					error = failure.message;
					this.services.tui.requestRender();
				},
			);
		};
		this.show(
			new HermesAdviceView({
				review: () => review,
				loading: () => loading,
				error: () => error,
				height: () => this.services.tui.terminal.rows,
				onRefresh: refresh,
				onExecute: (card) => this.confirmHermesAction(card),
				onDismiss: (card) => {
					void this.services.advisor.recordFeedback(feedbackFor(card, "dismissed"));
					if (review) review = { ...review, cards: review.cards.filter((item) => item.id !== card.id) };
					this.services.tui.requestRender();
				},
				onClose: () => this.closeOverlay(),
			}),
			{ width: "90%", maxHeight: "85%" },
		);
		refresh();
	}

	private confirmHermesAction(card: HermesAdviceCard): void {
		if (!card.action) {
			this.notify("Hermes card has no action");
			void this.services.advisor.recordFeedback(feedbackFor(card, "accepted", "no action"));
			return;
		}
		const message = this.hermesActionMessage(card.action);
		this.confirm("Hermes action", `${message}\n\n${card.body}`, () => {
			void this.services.advisor.recordFeedback(feedbackFor(card, "accepted"));
			this.executeHermesAction(card);
		});
	}

	private hermesRow(pid: number): SessionRow | undefined {
		return this.services.store.rows.get(pid);
	}

	private hermesActionMessage(action: HermesCardAction): string {
		switch (action.kind) {
			case "ask": {
				const row = this.hermesRow(action.pid);
				return `Ask ${row ? rowLabel(row) : `pid ${action.pid}`}: "${action.question}"?`;
			}
			case "prompt": {
				const row = this.hermesRow(action.pid);
				return `Send prompt to ${row ? rowLabel(row) : `pid ${action.pid}`}: "${action.text}"?`;
			}
			case "compact": {
				const row = this.hermesRow(action.pid);
				return `Compact ${row ? rowLabel(row) : `pid ${action.pid}`}?`;
			}
			case "notify":
				return `Show notification: "${action.message}"?`;
			case "memory_proposal":
				return `Record this memory proposal in the Hermes feedback ledger?\n${action.text}`;
			case "skill_proposal":
				return `Record this skill proposal in the Hermes feedback ledger?\n${action.title}`;
		}
	}

	private executeHermesAction(card: HermesAdviceCard): void {
		const action = card.action;
		if (!action) return;
		const succeeded = (detail?: string) => void this.services.advisor.recordFeedback(feedbackFor(card, "executed", detail));
		const failed = (detail: string) => void this.services.advisor.recordFeedback(feedbackFor(card, "failed", detail));
		switch (action.kind) {
			case "ask": {
				const row = this.hermesRow(action.pid);
				if (!row || !this.requireBridge(row)) {
					failed("session unavailable");
					return;
				}
				this.services.hub.send(row.bridge!, { kind: "ask", question: action.question }).then(
					() => {
						const id = this.services.store.rows.get(row.pid)?.bridge?.asks.at(-1)?.id;
						if (id !== undefined) this.awaitingAnswer.set(row.pid, id);
						this.notify(`asked ${rowLabel(row)}`);
						succeeded();
					},
					(error: Error) => {
						this.notify(`${rowLabel(row)}: ${error.message}`, true);
						failed(error.message);
					},
				);
				return;
			}
			case "prompt": {
				const row = this.hermesRow(action.pid);
				if (!row || !this.requireBridge(row)) {
					failed("session unavailable");
					return;
				}
				const working = row.bridge?.phase === "working";
				const deliverAs = working ? (action.deliverAs ?? "steer") : undefined;
				this.services.hub.send(row.bridge!, { kind: "prompt", text: action.text, deliverAs }).then(
					() => {
						this.notify(working ? `queued Hermes prompt for ${rowLabel(row)}` : `sent Hermes prompt to ${rowLabel(row)}`);
						succeeded();
					},
					(error: Error) => {
						this.notify(`${rowLabel(row)}: ${error.message}`, true);
						failed(error.message);
					},
				);
				return;
			}
			case "compact": {
				const row = this.hermesRow(action.pid);
				if (!row || !this.requireBridge(row)) {
					failed("session unavailable");
					return;
				}
				this.services.hub.send(row.bridge!, { kind: "compact" }).then(
					() => {
						this.notify(`compacting ${rowLabel(row)}`);
						succeeded();
					},
					(error: Error) => {
						this.notify(`${rowLabel(row)}: ${error.message}`, true);
						failed(error.message);
					},
				);
				return;
			}
			case "notify":
				this.notify(action.message);
				succeeded();
				return;
			case "memory_proposal":
				this.notify("Hermes memory proposal recorded for review");
				succeeded(action.text);
				return;
			case "skill_proposal":
				this.notify("Hermes skill proposal recorded for review");
				succeeded(`${action.title}: ${action.body}`);
				return;
		}
	}

	private confirmClose(row: SessionRow, recycle: boolean): void {
		if (!this.requireBridge(row)) return;
		const label = rowLabel(row);
		const cwd = rowCwd(row);
		const working = row.bridge?.phase === "working";
		const message = `${recycle ? "Close and start a fresh session in the same project" : "Close"} ${label}?${working ? " It closes when the current run finishes (x aborts it)." : ""}`;
		this.confirm(recycle ? "Recycle" : "Close", message, () => {
			if (recycle && cwd) this.recycles.set(row.pid, { cwd, label: basename(cwd) });
			this.send(row, { kind: "shutdown" }, recycle ? `closing ${label}; a new session starts when it exits` : `closing ${label}`);
		});
	}

	private launch(cwd: string, label: string, sessionFile?: string, replaces?: SessionRow): void {
		try {
			const name = launchSession({ cwd, label, sessionFile }, this.services.store.ordered(), this.services.runtimeDir);
			this.services.store.expectLaunch(name, replaces?.slot, replaces?.pid);
			this.notify(`started ${name} in a detached screen (${shortPath(cwd)})`);
		} catch (error) {
			this.notify(`launch failed: ${(error as Error).message}`, true);
		}
	}

	private pickProject(title: string, onPick: (cwd: string) => void): void {
		const live = openCwds(this.services.store.ordered());
		const now = Date.now();
		const items: SelectItem[] = listProjects(this.services.sessionRoot, live).map((project) => ({
			value: project.cwd,
			label: shortPath(project.cwd),
			description: `${project.sessions} session${project.sessions === 1 ? "" : "s"} · ${live.includes(project.cwd) ? "open now" : `${fmtDuration(now - project.lastActive)} ago`}`,
		}));
		this.show(
			new Picker({
				title,
				items,
				extraItem: (filter) => {
					const path = filter.startsWith("~") ? join(homedir(), filter.slice(1)) : filter;
					if (!path.startsWith("/") || items.some((item) => item.value === path)) return undefined;
					try {
						return existsSync(path) && statSync(path).isDirectory() ? { value: path, label: `open ${shortPath(path)}`, description: "directory" } : undefined;
					} catch {
						return undefined;
					}
				},
				onSelect: (item) => {
					this.closeOverlay();
					onPick(item.value);
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private pickSession(row: SessionRow): void {
		const cwd = rowCwd(row);
		if (!cwd) return this.notify("Unknown project directory", true);
		const open = new Map<string, SessionRow>();
		for (const other of this.services.store.rows.values()) {
			if (other.exitedAt !== undefined) continue;
			if (other.bridge?.sessionFile) open.set(other.bridge.sessionFile, other);
		}
		const now = Date.now();
		const sessions = listSessions(this.services.sessionRoot, cwd, this.services.usage);
		const items: SelectItem[] = sessions.map((session) => {
			const holder = open.get(session.path);
			const usage = session.cost !== undefined ? ` · ${fmtTokens(session.tokens ?? 0)} tok · $${fmtCost(session.cost)} (30d)` : "";
			return {
				value: session.path,
				label: session.title,
				description: holder ? `open in slot ${holder.slot ?? "·"}` : `${fmtDuration(now - session.lastActive)} ago${usage}`,
			};
		});
		// Resuming the exited row's own session is the common case: put it first.
		const own = row.exitedAt !== undefined ? row.bridge?.sessionFile : undefined;
		if (own) items.sort((a, b) => Number(b.value === own) - Number(a.value === own));
		this.show(
			new Picker({
				title: `Resume in ${shortPath(cwd)}`,
				items,
				onSelect: (item) => {
					if (open.has(item.value)) {
						this.notify("That session is already open; select its row instead", true);
						return;
					}
					this.closeOverlay();
					const blocked = resumeBlocked(this.services.store.ordered(), cwd, item.value);
					if (blocked) return this.notify(blocked, true);
					this.launch(cwd, basename(cwd), item.value, row.exitedAt !== undefined ? row : undefined);
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private openPeek(row: SessionRow): void {
		const sty = rowSty(row);
		if (!sty || row.exitedAt !== undefined) return this.notify(`${rowLabel(row)} is not running inside screen`, true);
		const window = rowWindow(row);
		const file = join(this.services.runtimeDir, `peek-${row.pid}.txt`);
		this.peekFile = file;
		let lines: string[] | undefined;
		const refresh = () => {
			lines = readHardcopy(file) ?? lines;
			requestHardcopy(sty, window, file);
			this.services.tui.requestRender();
		};
		refresh();
		this.peekTimer = setInterval(refresh, PEEK_REFRESH_MS);
		this.peekTimer.unref();
		this.show(
			new Peek({
				title: `peek · ${rowLabel(row)} · screen ${sty}`,
				lines: () => lines,
				height: () => Math.floor(this.services.tui.terminal.rows * 0.85),
				onKey: (data) => {
					if (matchesKey(data, Key.escape) || data === "v" || data === "q") this.closeOverlay();
					else if (data === "p") {
						this.closeOverlay();
						this.compose(row);
					} else if (data === "a") {
						this.closeOverlay();
						void this.attach(row);
					} else if (data === "x") {
						this.closeOverlay();
						this.rowAction(row, "x");
					}
				},
			}),
			{ width: "90%", maxHeight: "85%" },
		);
	}

	private openReader(row: SessionRow): void {
		if (!row.bridge?.lastSaid) return this.notify(`${rowLabel(row)} has not replied yet`, true);
		const store = this.services.store;
		this.show(
			new Reader({
				title: `said · ${rowLabel(row)}`,
				text: () => store.rows.get(row.pid)?.bridge?.lastSaid ?? "",
				height: () => this.services.tui.terminal.rows,
				keys: [["p", "prompt"], ["Esc", "close"]],
				onKey: (data) => {
					if (matchesKey(data, Key.escape) || data === "s" || data === "q") this.closeOverlay();
					else if (data === "p") {
						this.closeOverlay();
						this.compose(row);
					}
				},
			}),
			{ width: "100%", maxHeight: "100%" },
		);
	}

	private async attach(row: SessionRow): Promise<void> {
		const sty = rowSty(row);
		if (!sty || row.exitedAt !== undefined) return this.notify(`${rowLabel(row)} is not running inside screen`, true);
		const tui = this.services.tui;
		this.attached = true;
		tui.stop({ preserveScreen: true });
		process.stdout.write(`\x1b[2J\x1b[H[pi-dash] attaching to ${sty} — press Ctrl-a d to return\n`);
		try {
			await attachSession(sty, rowWindow(row));
		} finally {
			this.attached = false;
			tui.start();
			// Renders requested while stopped are dropped; force a full redraw.
			tui.requestRender(true);
		}
	}
}
