// Root component: owns the current view, selection, overlays and user actions.
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Component, Key, matchesKey, type OverlayHandle, type OverlayOptions, type SelectItem, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { type Command, THINKING_LEVELS } from "../../protocol/index.ts";
import { attachSession, launchSession, readHardcopy, requestHardcopy } from "../actions/screen.ts";
import { listProjects, listSessions } from "../actions/sessions.ts";
import type { BridgeHub } from "../collectors/bridges.ts";
import type { GpuMonitor } from "../collectors/gpu.ts";
import type { QuotaMonitor } from "../collectors/quota.ts";
import { isAlert } from "../model/status.ts";
import { rowCwd, rowLabel, rowSty, rowWindow, type SessionRow, type Store } from "../model/store.ts";
import type { UsageIndex } from "../usage/usage-index.ts";
import { fmtCost, fmtDuration, fmtTokens, shortPath } from "./format.ts";
import { Composer, Confirm, Help, Peek, Picker, Reader, TextPrompt } from "./overlays.ts";
import { TextPane } from "./text-pane.ts";
import { keyHints, theme } from "./theme.ts";
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
	sessionRoot: string;
	/** Private runtime directory for transient files (peek captures). */
	runtimeDir: string;
	quit: () => void;
}

const FLASH_MS = 5000;
const PEEK_REFRESH_MS = 1000;

const KEYS: Record<ViewName, [string, string][]> = {
	overview: [["1-9", "select"], ["Tab", "next ◆"], ["⏎", "detail"], ["p", "prompt"], ["x", "abort"], ["s", "said"], ["v", "peek"], ["a", "attach"], ["n", "new"], ["r", "resume"], ["c", "close"], ["u", "usage"], ["?", "help"], ["q", "quit"]],
	detail: [["Esc", "back"], ["Tab", "next ◆"], ["p", "prompt"], ["x", "abort"], ["s", "read said"], ["PgUp/PgDn", "scroll said"], ["v", "peek"], ["a", "attach"], ["M", "model"], ["T", "thinking"], ["Z", "compact"], ["c", "close"], ["R", "rename"], ["?", "help"]],
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

	/** Periodic housekeeping: launch replacement sessions for closed recycles. */
	onTick(): void {
		for (const [pid, recycle] of this.recycles) {
			const row = this.services.store.rows.get(pid);
			if (row && row.exitedAt === undefined) continue;
			this.recycles.delete(pid);
			this.launch(recycle.cwd, recycle.label, undefined, row);
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
				if ("pxsvacCRrdMTZ".includes(data)) this.notify("No session selected", true);
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
		const label = rowLabel(row);
		switch (key) {
			case "p":
				return this.compose(row);
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
		this.services.hub.send(row.pid, command).then(
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

	/** Pending recycles live only in this process, so quitting drops their replacement launch. */
	private requestQuit(): void {
		const pending = [...this.recycles.values()].map((recycle) => recycle.label);
		if (!pending.length) return this.services.quit();
		const message = `Close-and-restart is still pending for ${pending.join(", ")}. If pi-dash quits now, ${pending.length === 1 ? "that session still closes" : "those sessions still close"} but no new session starts. Quit anyway?`;
		this.confirm("Quit", message, () => this.services.quit());
	}

	private compose(row: SessionRow): void {
		if (!this.requireBridge(row)) return;
		const store = this.services.store;
		this.show(
			new Composer(this.services.tui, {
				target: `${row.slot ?? "·"} ${rowLabel(row)}`,
				isWorking: () => store.rows.get(row.pid)?.bridge?.phase === "working",
				suggestion: () => store.rows.get(row.pid)?.bridge?.suggestion,
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
			const name = launchSession({ cwd, label, sessionFile });
			this.services.store.expectLaunch(name, replaces?.slot, replaces?.pid);
			this.notify(`started ${name} in a detached screen (${shortPath(cwd)})`);
		} catch (error) {
			this.notify(`launch failed: ${(error as Error).message}`, true);
		}
	}

	private pickProject(title: string, onPick: (cwd: string) => void): void {
		const live = this.services.store.ordered().flatMap((row) => {
			const cwd = rowCwd(row);
			return cwd && row.exitedAt === undefined ? [cwd] : [];
		});
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
		// Live sessions in this project without a bridge do not report which session file they hold.
		const unknown: SessionRow[] = [];
		for (const other of this.services.store.rows.values()) {
			if (other.exitedAt !== undefined) continue;
			if (other.bridge?.sessionFile) open.set(other.bridge.sessionFile, other);
			else if (!other.bridge && rowCwd(other) === cwd) unknown.push(other);
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
					const resume = () => this.launch(cwd, basename(cwd), item.value, row.exitedAt !== undefined ? row : undefined);
					if (!unknown.length) return resume();
					// pi appends to session files without locking: two processes on one file mix their histories.
					const holders = unknown.map((other) => (other.slot !== undefined ? `slot ${other.slot}` : `pid ${other.pid}`)).join(", ");
					const one = unknown.length === 1;
					const message = `${holders} in this project ${one ? "has" : "have"} no bridge, so pi-dash cannot tell which session ${one ? "it has" : "they have"} open. If ${one ? "it is" : "one of them is"} "${item.label}", two pi processes will write to the same session file and mix its history. Resume anyway?`;
					this.confirm("Resume", message, resume);
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
