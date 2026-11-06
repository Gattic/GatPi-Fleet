// Root component: owns the current view, selection, overlays and user actions.
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { type Component, Key, matchesKey, type OverlayHandle, type OverlayOptions, type SelectItem, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { type Command, THINKING_LEVELS, type DeliverAs } from "../../protocol/index.ts";
import { COMMIT_REVIEW_PROMPT, gitDirtySummary, gitHeadLabel, type GitBranch, type GitOperationResult, type GitService, type GitSummary, isGitSummaryClean } from "../../manager/actions/git.ts";
import { attachSession } from "../actions/screen.ts";
import { launchSession, resumeBlocked } from "../../manager/actions/launch.ts";
import { readHardcopy, requestHardcopy } from "../../manager/actions/peek.ts";
import { listProjects, listSessions, type Project, type SessionSummary } from "../../manager/actions/sessions.ts";
import type { GpuMonitor } from "../../manager/collectors/gpu.ts";
import type { ContextWindows } from "../../manager/context/windows.ts";
import { buildHermesSnapshot, feedbackFor, type HermesAdviceCard, type HermesAdvisorClient, type HermesCardAction } from "../hermes/advisor.ts";
import type { QuotaMonitor } from "../../manager/collectors/quota.ts";
import { isAlert } from "../../manager/model/status.ts";
import { hostRows, openCwds, rowCwd, rowIncarnation, rowLabel, rowSty, rowWindow, type SessionRow, type Store } from "../../manager/model/store.ts";
import type { Network } from "../../manager/network.ts";
import type { InterruptedSession } from "../../manager/recovery.ts";
import { RemoteGit } from "../../manager/remote/git.ts";
import { USAGE_RANGES, type UsageMetric, type UsageRange } from "../../manager/usage/report.ts";
import type { UsageIndex } from "../../manager/usage/usage-index.ts";
import type { RelayOp, RelayOps } from "../../relay/protocol.ts";
import { fit, fmtCost, fmtDuration, fmtTokens, shortPath } from "./format.ts";
import { AskView, Composer, Confirm, Help, HermesAdviceView, Peek, Picker, Reader, TextPrompt } from "./overlays.ts";
import { TextPane } from "./text-pane.ts";
import { keyHints, theme } from "./theme.ts";
import { GitView } from "./git-view.ts";
import { type DetailView, renderDetail } from "./views/detail.ts";
import { CONTEXT_SCOPES, contextRowCount, contextVisibleRows, renderContext, type ContextScope } from "./views/context.ts";
import { jobPageSize, jobRows, renderJobs } from "./views/jobs.ts";
import { renderOverview } from "./views/overview.ts";
import { roadmapText } from "./views/roadmap.ts";
import { background, hostStatusText, SPINNER, type ViewContext, type ViewName } from "./views/shared.ts";
import { renderUsage } from "./views/usage.ts";

export interface Services {
	tui: TUI;
	store: Store;
	/** Sends commands to sessions on this machine and on the remote hosts. */
	network: Network;
	usage: UsageIndex;
	windows: ContextWindows;
	quota: QuotaMonitor;
	gpu: GpuMonitor;
	advisor: HermesAdvisorClient;
	git: GitService;
	/** Removes an exited session's row, also from the gateway (and so the phone). */
	dismiss: (row: SessionRow) => Promise<void>;
	interruptedSessions: () => InterruptedSession[];
	resumeInterrupted: (entry: InterruptedSession) => Promise<string>;
	dismissInterrupted: (entry: InterruptedSession) => Promise<void>;
	sessionRoot: string;
	/** Private runtime directory for transient files (peek captures). */
	runtimeDir: string;
	quit: () => void;
}

const FLASH_MS = 5000;
const PEEK_REFRESH_MS = 1000;
const GIT_MESSAGE_LIMIT = 500;


const KEYS: Record<ViewName, [string, string][]> = {
	overview: [["1-9", "select"], ["Tab", "next ◆"], ["⏎", "detail"], ["o", "roadmap"], ["p", "prompt"], ["i", "ask"], ["H", "Hermes"], ["g", "git"], ["x", "abort"], ["s", "said"], ["v", "peek"], ["a", "attach"], ["n", "new"], ["r", "resume"], ["e", "interrupted"], ["c", "close"], ["u", "usage"], ["K", "context"], ["J", "jobs"], ["?", "help"], ["q", "quit"]],
	detail: [["Esc", "back"], ["Tab", "next ◆"], ["o", "roadmap"], ["p", "prompt"], ["i", "ask"], ["H", "Hermes"], ["g", "git"], ["x", "abort"], ["s", "read said"], ["PgUp/PgDn", "scroll said"], ["v", "peek"], ["a", "attach"], ["M", "model"], ["T", "thinking"], ["Z", "compact"], ["c", "close"], ["R", "rename"], ["K", "context"], ["J", "jobs"], ["?", "help"]],
	jobs: [["Esc", "back"], ["j/k", "scroll"], ["PgUp/PgDn", "page"], ["?", "help"]],
	usage: [["Esc", "back"], ["t", "today"], ["w", "7 days"], ["m", "30 days"], ["$", "cost/tokens"], ["K", "context"], ["?", "help"]],
	context: [["Esc", "back"], ["a", "scope"], ["j/k", "scroll"], ["PgUp/PgDn", "page"], ["⏎", "detail"], ["?", "help"]],
};

export class App implements Component {
	private view: ViewName = "overview";
	private selectedKey?: string;
	// A recycled or resumed session replaces its row in the same slot; selection follows it.
	private selectedSlot?: number;
	private range: UsageRange = "today";
	private metric: UsageMetric = "cost";
	private flash?: { text: string; error: boolean; until: number };
	private spinnerIndex = 0;
	private jobsOffset = 0;
	private contextScope: ContextScope = "open";
	private contextOffset = 0;
	private overlay?: OverlayHandle;
	private peekTimer?: NodeJS.Timeout;
	private peekFile?: string;
	private readonly recycles = new Map<string, { host?: string; cwd: string; label: string }>();
	// Asks sent from here that are still answering (row key → ask id), and the session whose ask view is open.
	private readonly awaitingAnswer = new Map<string, number>();
	private askViewKey?: string;
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
		for (const [key, recycle] of this.recycles) {
			const row = this.services.store.rows.get(key);
			if (row && row.exitedAt === undefined) continue;
			this.recycles.delete(key);
			this.launch(recycle.host, recycle.cwd, recycle.label, undefined, row);
		}
		for (const [key, id] of this.awaitingAnswer) {
			const row = this.services.store.rows.get(key);
			const ask = row?.bridge?.asks.find((run) => run.id === id);
			if (ask?.status === "answering") continue;
			this.awaitingAnswer.delete(key);
			if (!row || !ask || this.askViewKey === key) continue;
			if (ask.status === "answered") this.notify(`${rowLabel(row)} answered your question (i to read it)`);
			else this.notify(`${rowLabel(row)} could not answer: ${ask.error ?? "failed"}`, true);
		}
	}

	private selected(): SessionRow | undefined {
		const rows = this.services.store.ordered();
		const current = rows.find((row) => row.key === this.selectedKey) ?? rows.find((row) => row.slot !== undefined && row.slot === this.selectedSlot) ?? rows[0];
		this.selectedKey = current?.key;
		this.selectedSlot = current?.slot;
		return current;
	}

	private select(row: SessionRow | undefined): void {
		if (!row) return;
		this.selectedKey = row.key;
		this.selectedSlot = row.slot;
		this.services.store.acknowledge(row.key);
	}

	private viewContext(now = Date.now()): ViewContext {
		return {
			store: this.services.store,
			remotes: this.services.network.remotes,
			usage: this.services.usage,
			windows: this.services.windows,
			quota: this.services.quota,
			gpu: this.services.gpu,
			now,
			spinner: SPINNER[this.spinnerIndex],
			selected: this.selected(),
		};
	}

	render(width: number): string[] {
		const height = Math.max(5, this.services.tui.terminal.rows);
		const now = Date.now();
		const ctx = this.viewContext(now);
		const detail = this.view === "detail" ? renderDetail(ctx, width, height, this.said) : undefined;
		this.saidArea = detail?.said;
		const interrupted = this.services.interruptedSessions().length;
		const banner = this.view === "overview" && interrupted > 0;
		const body = detail
			? detail.lines
			: this.view === "usage"
				? renderUsage(ctx, width, height, this.range, this.metric)
				: this.view === "jobs"
					? renderJobs(ctx, width, height, this.jobsOffset)
					: this.view === "context"
						? renderContext(ctx, width, height, this.contextScope, this.contextOffset)
						: renderOverview(ctx, width, height - Number(banner));
		if (banner) body.splice(1, 0, fit(theme.waiting(` ! ${interrupted} interrupted session${interrupted === 1 ? "" : "s"} · e to review / resume`), width));
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
		if (data === "e") return this.pickInterrupted();
		if (data === "J") {
			this.view = this.view === "jobs" ? "overview" : "jobs";
			this.jobsOffset = 0;
		} else if (this.view === "jobs" && (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.down) || data === "j")) {
			const delta = matchesKey(data, Key.up) || data === "k" ? -1 : 1;
			this.jobsOffset = this.clampJobsOffset(this.jobsOffset + delta);
		} else if (this.view === "jobs" && (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown))) {
			const page = jobPageSize(this.services.tui.terminal.rows);
			this.jobsOffset = this.clampJobsOffset(this.jobsOffset + (matchesKey(data, Key.pageUp) ? -page : page));
		} else if (this.view === "jobs" && (/^[1-9]$/.test(data) || matchesKey(data, Key.tab))) {
			// The jobs page is read-only; session selection keys do not apply here.
		} else if (data === "K") {
			this.view = this.view === "context" ? "overview" : "context";
			this.contextOffset = 0;
		} else if (this.view === "context" && (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.down) || data === "j")) {
			const delta = matchesKey(data, Key.up) || data === "k" ? -1 : 1;
			this.contextOffset = this.clampContextOffset(this.contextOffset + delta);
		} else if (this.view === "context" && (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown))) {
			const page = contextVisibleRows(this.services.tui.terminal.columns, this.services.tui.terminal.rows);
			this.contextOffset = this.clampContextOffset(this.contextOffset + (matchesKey(data, Key.pageUp) ? -page : page));
		} else if (this.view === "context" && data === "a") {
			const index = CONTEXT_SCOPES.indexOf(this.contextScope);
			this.contextScope = CONTEXT_SCOPES[(index + 1) % CONTEXT_SCOPES.length];
			this.contextOffset = 0;
		} else if (/^[1-9]$/.test(data)) {
			this.select(store.bySlot(Number(data)));
		} else if (matchesKey(data, Key.tab)) {
			this.selectNextAttention();
		} else if (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.down) || data === "j") {
			const rows = store.ordered();
			const index = rows.findIndex((row) => row.key === this.selected()?.key);
			const delta = matchesKey(data, Key.up) || data === "k" ? -1 : 1;
			this.select(rows[Math.max(0, Math.min(rows.length - 1, index + delta))]);
		} else if (matchesKey(data, Key.enter)) {
			if (this.view === "context") this.view = "detail";
			else if (this.view !== "jobs") this.view = this.view === "detail" ? "overview" : "detail";
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
			this.newSession();
		} else {
			if (this.view === "jobs") return;
			const row = this.selected();
			if (!row) {
				if ("ogpixsvacCRrdMTZ".includes(data)) this.notify("No session selected", true);
				return;
			}
			this.rowAction(row, data);
		}
		this.services.tui.requestRender();
	}

	private clampJobsOffset(offset: number): number {
		const count = jobRows(this.services.store.ordered()).length;
		const page = jobPageSize(this.services.tui.terminal.rows);
		return Math.max(0, Math.min(offset, Math.max(0, count - page)));
	}

	private clampContextOffset(offset: number): number {
		const rows = contextRowCount(this.viewContext(), this.contextScope);
		const visible = contextVisibleRows(this.services.tui.terminal.columns, this.services.tui.terminal.rows);
		return Math.max(0, Math.min(offset, Math.max(0, rows - visible)));
	}

	/** Sessions that need attention (needs you, error, stalled), longest waiting first; each press selects the next one. */
	private selectNextAttention(): void {
		const candidates = this.services.store
			.ordered()
			.filter((row) => isAlert(row.status.kind))
			.sort((a, b) => (a.status.since ?? Number.POSITIVE_INFINITY) - (b.status.since ?? Number.POSITIVE_INFINITY));
		if (!candidates.length) return this.notify("No session needs you");
		const current = candidates.findIndex((row) => row.key === this.selected()?.key);
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
			case "o":
				return this.openRoadmap(row);
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
			case "r": {
				const interrupted = this.recoveryFor(row);
				return interrupted ? this.confirmRecovery(interrupted) : this.pickSession(row);
			}
			case "d": {
				if (row.exitedAt === undefined) return this.notify("Only exited sessions can be dismissed", true);
				this.services.dismiss(row).then(
					() => this.notify("Exited session dismissed; saved conversation kept"),
					(error: Error) => this.notify(`dismiss failed: ${error.message}`, true),
				);
				return;
			}
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
		if (!row.bridge || !this.services.network.isConnected(row)) {
			const remote = row.host === undefined ? undefined : this.services.network.remotes.get(row.host);
			if (remote && remote.status.kind !== "online") this.notify(`${remote.name} is ${remote.status.kind}; ${rowLabel(row)} cannot be reached`, true);
			else this.notify(`${rowLabel(row)} has no bridge connection (started before pi-dash was installed?)`, true);
			return false;
		}
		return true;
	}

	private send(row: SessionRow, command: Command, success: string): void {
		this.services.network.send(row, command).then(
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
		this.askViewKey = undefined;
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

	/** Git runs where the session's project is. */
	private gitFor(row: SessionRow): GitService {
		return row.host === undefined ? this.services.git : new RemoteGit(this.services.network.remote(row.host));
	}

	private openGit(row: SessionRow): void {
		const cwd = rowCwd(row);
		if (!cwd) return this.notify("Unknown project directory", true);
		const git = this.gitFor(row);
		let summary: GitSummary | undefined;
		let loading = false;
		let error: string | undefined;
		const refresh = () => {
			if (loading) return;
			loading = true;
			error = undefined;
			this.services.tui.requestRender();
			git.getSummary(cwd).then(
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
				onPull: () => this.confirmGitPull(git, row, cwd, summary),
				onPush: () => this.confirmGitPush(git, cwd, summary),
				onSwitch: () => void this.pickGitBranch(git, row, cwd, summary),
				onStatus: () => void this.showGitStatus(git, row, cwd),
				onCommitPrompt: () => this.openCommitPrompt(row, summary),
				onRefresh: refresh,
				onClose: () => this.closeOverlay(),
			}),
			{ width: "80%", maxHeight: "85%" },
		);
		refresh();
	}

	private confirmGitPull(git: GitService, row: SessionRow, cwd: string, summary: GitSummary | undefined): void {
		if (!summary) return this.notify("Git status has not loaded yet", true);
		if (!summary.branch) return this.notify("Cannot pull from detached HEAD", true);
		if (!summary.upstream) return this.notify("No upstream is configured; set one in git first", true);
		const dirty = isGitSummaryClean(summary) ? "" : `\n\nWorking tree is ${gitDirtySummary(summary)}; git may refuse if local changes overlap.`;
		const message = `Run git pull --ff-only in ${this.projectPath(row.host, summary.root)} on ${gitHeadLabel(summary)}?${dirty}${this.workingSessionWarning(row.host, cwd)}`;
		this.confirm("Git pull", message, () => this.runGitAction(() => git.pull(cwd), `pulled ${gitHeadLabel(summary)}`));
	}

	private confirmGitPush(git: GitService, cwd: string, summary: GitSummary | undefined): void {
		if (!summary) return this.notify("Git status has not loaded yet", true);
		if (!summary.branch) return this.notify("Cannot push from detached HEAD", true);
		let action: () => Promise<GitOperationResult>;
		let command: string;
		let target: string;
		if (summary.upstream) {
			action = () => git.push(cwd);
			command = "git push";
			target = summary.upstream;
		} else {
			if (summary.remotes.length !== 1) return this.notify("No upstream is configured; set one in git first", true);
			const remote = summary.remotes[0];
			action = () => git.pushSetUpstream(cwd, remote);
			command = `git push -u ${remote} HEAD`;
			target = `${remote}/${summary.branch}`;
		}
		const behind = summary.behind ? `\n\n${gitHeadLabel(summary)} is behind ${summary.upstream ?? target} by ${summary.behind}; push may be rejected until you pull.` : "";
		const ahead = summary.ahead ? ` (${summary.ahead} ahead)` : "";
		this.confirm("Git push", `Run ${command} and publish ${gitHeadLabel(summary)}${ahead} to ${target}?${behind}`, () => this.runGitAction(action, `pushed ${gitHeadLabel(summary)}`));
	}

	private async pickGitBranch(git: GitService, row: SessionRow, cwd: string, summary: GitSummary | undefined): Promise<void> {
		if (!summary) return this.notify("Git status has not loaded yet", true);
		if (!isGitSummaryClean(summary)) return this.notify("Working tree has changes; ask the agent to review, commit, or stash first", true);
		const menu = this.overlay;
		let branches: GitBranch[];
		try {
			branches = await git.listBranches(cwd);
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
				title: `Switch branch in ${this.projectPath(row.host, summary.root)}`,
				items,
				onSelect: (item) => {
					if (item.value === summary.branch) {
						this.notify(`${item.label} is already checked out`);
						return;
					}
					const message = `Switch ${rowLabel(row)} from ${gitHeadLabel(summary)} to ${item.value}?${this.workingSessionWarning(row.host, cwd)}`;
					this.confirm("Switch branch", message, () => this.runGitAction(() => git.switchBranch(cwd, item.value), `switched ${rowLabel(row)} to ${item.value}`));
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private async showGitStatus(git: GitService, row: SessionRow, cwd: string): Promise<void> {
		const menu = this.overlay;
		let output: string;
		try {
			output = await git.status(cwd);
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

	private workingSessionWarning(host: string | undefined, cwd: string): string {
		const working = hostRows(this.services.store.ordered(), host)
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
				isWorking: () => store.rows.get(row.key)?.bridge?.phase === "working",
				suggestion: () => store.rows.get(row.key)?.bridge?.suggestion,
				initialText,
				initialMode,
				onSubmit: (text, deliverAs) => {
					this.closeOverlay();
					const working = store.rows.get(row.key)?.bridge?.phase === "working";
					this.send(row, { kind: "prompt", text, deliverAs: working ? deliverAs : undefined }, working ? `queued as ${deliverAs === "steer" ? "steer" : "follow-up"} for ${rowLabel(row)}` : `sent to ${rowLabel(row)}`);
				},
				onCancel: () => this.closeOverlay(),
			}),
			{ width: "80%", maxHeight: "60%" },
		);
	}

	private openAsk(row: SessionRow): void {
		if (!this.requireBridge(row)) return;
		const { store, network, tui } = this.services;
		this.show(
			new AskView(tui, {
				target: `${row.slot ?? "·"} ${rowLabel(row)}`,
				asks: () => store.rows.get(row.key)?.bridge?.asks ?? [],
				height: () => tui.terminal.rows,
				onAsk: (question) =>
					network
						.send(row, { kind: "ask", question })
						.then(() => {
							// The bridge sends the new ask before its ack.
							const id = store.rows.get(row.key)?.bridge?.asks.at(-1)?.id;
							if (id !== undefined) this.awaitingAnswer.set(row.key, id);
						})
						.finally(() => tui.requestRender()),
				onClose: () => this.closeOverlay(),
			}),
			{ width: "100%", maxHeight: "100%" },
		);
		// After show(), which closes any earlier overlay.
		this.askViewKey = row.key;
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

	private hermesRow(session: string): SessionRow | undefined {
		return this.services.store.rows.get(session);
	}

	private hermesActionMessage(action: HermesCardAction): string {
		switch (action.kind) {
			case "ask": {
				const row = this.hermesRow(action.session);
				return `Ask ${row ? rowLabel(row) : `session ${action.session}`}: "${action.question}"?`;
			}
			case "prompt": {
				const row = this.hermesRow(action.session);
				return `Send prompt to ${row ? rowLabel(row) : `session ${action.session}`}: "${action.text}"?`;
			}
			case "compact": {
				const row = this.hermesRow(action.session);
				return `Compact ${row ? rowLabel(row) : `session ${action.session}`}?`;
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
				const row = this.hermesRow(action.session);
				if (!row || !this.requireBridge(row)) {
					failed("session unavailable");
					return;
				}
				this.services.network.send(row, { kind: "ask", question: action.question }).then(
					() => {
						const id = this.services.store.rows.get(row.key)?.bridge?.asks.at(-1)?.id;
						if (id !== undefined) this.awaitingAnswer.set(row.key, id);
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
				const row = this.hermesRow(action.session);
				if (!row || !this.requireBridge(row)) {
					failed("session unavailable");
					return;
				}
				const working = row.bridge?.phase === "working";
				const deliverAs = working ? (action.deliverAs ?? "steer") : undefined;
				this.services.network.send(row, { kind: "prompt", text: action.text, deliverAs }).then(
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
				const row = this.hermesRow(action.session);
				if (!row || !this.requireBridge(row)) {
					failed("session unavailable");
					return;
				}
				this.services.network.send(row, { kind: "compact" }).then(
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
			if (recycle && cwd) this.recycles.set(row.key, { host: row.host, cwd, label: basename(cwd) });
			this.send(row, { kind: "shutdown" }, recycle ? `closing ${label}; a new session starts when it exits` : `closing ${label}`);
		});
	}

	/** A request to a remote host's relay (rejected, not thrown, for a host that is not configured). */
	private async request<K extends RelayOp>(host: string, op: K, params: RelayOps[K]["params"]): Promise<RelayOps[K]["result"]> {
		return this.services.network.remote(host).request(op, params);
	}

	/** A project directory as the user knows it: `~/…` here, `host:/path` on a remote host. */
	private projectPath(host: string | undefined, path: string): string {
		return host === undefined ? shortPath(path) : `${host}:${path}`;
	}

	/** Starts pi on `host` (this machine when undefined). */
	private launch(host: string | undefined, cwd: string, label: string, sessionFile?: string, replaces?: SessionRow): void {
		const started = (name: string) => {
			this.services.store.expectLaunch(name, replaces?.slot, replaces?.key, host);
			this.notify(`started ${name} in a detached screen (${this.projectPath(host, cwd)})`);
		};
		const failed = (error: Error) => this.notify(`launch failed: ${error.message}`, true);
		if (host !== undefined) {
			this.request(host, "launch", { cwd, label, sessionFile }).then(started, failed);
			return;
		}
		try {
			started(launchSession({ cwd, label, sessionFile }, hostRows(this.services.store.ordered(), undefined), this.services.runtimeDir));
		} catch (error) {
			failed(error as Error);
		}
	}

	/** With remote hosts configured, `n` first asks where the session should run. */
	private newSession(): void {
		const remotes = [...this.services.network.remotes.values()];
		if (!remotes.length) return this.pickProject(undefined);
		const items: SelectItem[] = [
			{ value: "", label: hostname(), description: "this machine" },
			...remotes.map((remote) => ({ value: remote.name, label: remote.name, description: hostStatusText(remote, Date.now()) })),
		];
		this.show(
			new Picker({
				title: "New session on…",
				items,
				onSelect: (item) => {
					this.closeOverlay();
					this.pickProject(item.value || undefined);
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private pickProject(host: string | undefined): void {
		const live = openCwds(hostRows(this.services.store.ordered(), host));
		if (host === undefined) return this.showProjects(undefined, listProjects(this.services.sessionRoot, live), live);
		// A picker arriving late must not replace whatever the user opened meanwhile.
		const before = this.overlay;
		this.request(host, "projects", { live }).then(
			(projects) => {
				if (this.overlay === before) this.showProjects(host, projects, live);
			},
			(error: Error) => this.notify(`${host}: ${error.message}`, true),
		);
	}

	private showProjects(host: string | undefined, projects: readonly Project[], live: readonly string[]): void {
		const now = Date.now();
		const items: SelectItem[] = projects.map((project) => ({
			value: project.cwd,
			label: host === undefined ? shortPath(project.cwd) : project.cwd,
			description: `${project.sessions} session${project.sessions === 1 ? "" : "s"} · ${live.includes(project.cwd) ? "open now" : `${fmtDuration(now - project.lastActive)} ago`}`,
		}));
		this.show(
			new Picker({
				title: host === undefined ? "New session in…" : `New session on ${host} in…`,
				items,
				extraItem: (filter) => (host === undefined ? localDirectoryItem(filter, items) : remoteDirectoryItem(host, filter, items)),
				onSelect: (item) => {
					this.closeOverlay();
					this.launch(host, item.value, basename(item.value));
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private recoveryFor(row: SessionRow): InterruptedSession | undefined {
		return this.services.interruptedSessions().find((entry) => entry.host === row.host && entry.instanceId === row.bridge?.instanceId);
	}

	private pickInterrupted(): void {
		const entries = this.services.interruptedSessions();
		if (!entries.length) return this.notify("No interrupted sessions recorded on connected hosts");
		this.show(new Picker({
			title: "Interrupted sessions · no graceful shutdown recorded",
			items: entries.map((entry, index) => ({ value: String(index), label: `${entry.name || basename(entry.cwd)} · ${entry.sessionId}`, description: this.projectPath(entry.host, entry.cwd) })),
			onSelect: (item) => {
				const entry = entries[Number(item.value)];
				this.show(new Picker({
					title: `${entry.name || basename(entry.cwd)} · ${this.projectPath(entry.host, entry.cwd)}`,
					items: [
						{ value: "resume", label: "Resume interrupted session", description: `pi --session ${entry.sessionFile}` },
						{ value: "dismiss", label: "Dismiss recovery suggestion", description: "Keeps the saved conversation" },
					],
					onSelect: (action) => {
						this.closeOverlay();
						if (action.value === "resume") this.confirmRecovery(entry);
						else this.confirm("Dismiss recovery", `Dismiss ${entry.name || entry.sessionId}? The saved conversation is not deleted.`, () => this.dismissRecovery(entry));
					},
					onCancel: () => this.closeOverlay(),
				}));
			},
			onCancel: () => this.closeOverlay(),
		}));
	}

	private confirmRecovery(entry: InterruptedSession): void {
		this.confirm("Resume interrupted session", `No graceful shutdown was recorded for ${entry.name || entry.sessionId} in ${this.projectPath(entry.host, entry.cwd)}. Resume with pi --session ${entry.sessionFile}?`, () => {
			const rows = hostRows(this.services.store.ordered(), entry.host);
			const blocked = resumeBlocked(rows, entry.cwd, entry.sessionFile);
			if (blocked) return this.notify(blocked, true);
			this.services.resumeInterrupted(entry).then((name) => {
				const replaces = rows.find((row) => row.exitedAt !== undefined && row.bridge?.instanceId === entry.instanceId);
				this.services.store.expectLaunch(name, replaces?.slot, replaces?.key, entry.host);
				this.notify(`started ${name}; recovery clears when pi reconnects (a to attach)`);
			}, (error: Error) => this.notify(`recovery failed: ${error.message}`, true));
		});
	}

	private dismissRecovery(entry: InterruptedSession): void {
		this.services.dismissInterrupted(entry).then(
			() => this.notify("Recovery suggestion dismissed; saved conversation kept"),
			(error: Error) => this.notify(`dismiss failed: ${error.message}`, true),
		);
	}

	private pickSession(row: SessionRow): void {
		const cwd = rowCwd(row);
		if (!cwd) return this.notify("Unknown project directory", true);
		if (row.host === undefined) return this.showSessions(row, cwd, listSessions(this.services.sessionRoot, cwd, this.services.usage));
		const host = row.host;
		const before = this.overlay;
		this.request(host, "sessions", { cwd }).then(
			(sessions) => {
				if (this.overlay === before) this.showSessions(row, cwd, sessions);
			},
			(error: Error) => this.notify(`${host}: ${error.message}`, true),
		);
	}

	private showSessions(row: SessionRow, cwd: string, sessions: readonly SessionSummary[]): void {
		// Session files are paths on the session's host.
		const open = new Map<string, SessionRow>();
		for (const other of hostRows(this.services.store.ordered(), row.host)) {
			if (other.exitedAt !== undefined) continue;
			if (other.bridge?.sessionFile) open.set(other.bridge.sessionFile, other);
		}
		const now = Date.now();
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
				title: `Resume in ${this.projectPath(row.host, cwd)}`,
				items,
				onSelect: (item) => {
					if (open.has(item.value)) {
						this.notify("That session is already open; select its row instead", true);
						return;
					}
					this.closeOverlay();
					const blocked = resumeBlocked(hostRows(this.services.store.ordered(), row.host), cwd, item.value);
					if (blocked) return this.notify(blocked, true);
					this.launch(row.host, cwd, basename(cwd), item.value, row.exitedAt !== undefined ? row : undefined);
				},
				onCancel: () => this.closeOverlay(),
			}),
		);
	}

	private openPeek(row: SessionRow): void {
		const sty = rowSty(row);
		if (!sty || row.exitedAt !== undefined) return this.notify(`${rowLabel(row)} is not running inside screen`, true);
		const window = rowWindow(row);
		let lines: string[] | undefined;
		let refresh: () => void;
		if (row.host === undefined) {
			const file = join(this.services.runtimeDir, `peek-${row.pid}.txt`);
			this.peekFile = file;
			refresh = () => {
				lines = readHardcopy(file) ?? lines;
				requestHardcopy(sty, window, file);
				this.services.tui.requestRender();
			};
		} else {
			const host = row.host;
			let waiting = false;
			refresh = () => {
				if (waiting) return;
				waiting = true;
				this.request(host, "peek", { pid: row.pid, sty, window })
					.then(
						(capture) => {
							lines = capture ?? lines;
							this.services.tui.requestRender();
						},
						// The peek keeps the last capture; the host's status line tells why it stopped.
						() => {},
					)
					.finally(() => {
						waiting = false;
					});
			};
		}
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

	private openRoadmap(row: SessionRow): void {
		const identity = rowIncarnation(row);
		this.show(new Reader({
			title: () => {
				const current = this.services.store.rows.get(row.key);
				const status = !current || rowIncarnation(current) !== identity ? "session changed" : !current.connected || current.exitedAt !== undefined ? "last known" : "live";
				return `Roadmap Viewer · ${status} · ${rowLabel(row)}`;
			},
			plain: true,
			keepPosition: true,
			text: () => {
				const current = this.services.store.rows.get(row.key);
				if (!current || rowIncarnation(current) !== identity) return "Session ended or reloaded. Close this viewer and select its current instance.";
				return roadmapText(current.bridge?.plan, !current.connected || current.exitedAt !== undefined);
			},
			height: () => this.services.tui.terminal.rows,
			keys: [["Home/End", "top/end"], ["Esc", "close"]],
			onKey: (data) => {
				if (matchesKey(data, Key.escape) || data === "o" || data === "q") this.closeOverlay();
			},
		}), { width: "100%", maxHeight: "100%" });
	}

	private openReader(row: SessionRow): void {
		if (!row.bridge?.lastSaid) return this.notify(`${rowLabel(row)} has not replied yet`, true);
		const store = this.services.store;
		this.show(
			new Reader({
				title: `said · ${rowLabel(row)}`,
				text: () => store.rows.get(row.key)?.bridge?.lastSaid ?? "",
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
		process.stdout.write(`\x1b[2J\x1b[H[pi-dash] attaching to ${sty}${row.host === undefined ? "" : ` on ${row.host}`} — press Ctrl-a d to return\n`);
		try {
			await attachSession(sty, rowWindow(row), row.host);
		} finally {
			this.attached = false;
			tui.start();
			// Renders requested while stopped are dropped; force a full redraw.
			tui.requestRender(true);
		}
	}
}

/** A typed directory on this machine that the project list does not have. */
function localDirectoryItem(filter: string, items: readonly SelectItem[]): SelectItem | undefined {
	const path = filter.startsWith("~") ? join(homedir(), filter.slice(1)) : filter;
	if (!path.startsWith("/") || items.some((item) => item.value === path)) return undefined;
	try {
		return existsSync(path) && statSync(path).isDirectory() ? { value: path, label: `open ${shortPath(path)}`, description: "directory" } : undefined;
	} catch {
		return undefined;
	}
}

/** A typed directory on a remote host; the host checks it when the session starts (`~` is its home). */
function remoteDirectoryItem(host: string, filter: string, items: readonly SelectItem[]): SelectItem | undefined {
	if (!/^(\/|~(\/|$))/.test(filter) || items.some((item) => item.value === filter)) return undefined;
	return { value: filter, label: `open ${filter}`, description: `directory on ${host}` };
}
