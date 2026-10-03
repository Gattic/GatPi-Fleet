// Modal overlays: prompt composer, filterable picker, confirm, text input, peek, help.
import { type Component, Container, Editor, type EditorTheme, type Focusable, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, type SelectListTheme, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DeliverAs } from "../../protocol/index.ts";
import { fit } from "./format.ts";
import { theme } from "./theme.ts";

const selectListTheme: SelectListTheme = {
	selectedPrefix: (text) => theme.accent(text),
	selectedText: (text) => theme.bold(theme.accent(text)),
	description: (text) => theme.dim(text),
	scrollInfo: (text) => theme.dim(text),
	noMatch: (text) => theme.dim(text),
};

const editorTheme: EditorTheme = { borderColor: (text) => theme.dim(text), selectList: selectListTheme };

/** Bordered box with a title row and an optional footer hint. */
export function frame(title: string, body: readonly string[], width: number, hint = ""): string[] {
	const inner = Math.max(1, width - 4);
	const titleText = ` ${title} `;
	const top = theme.dim("╭─") + theme.bold(titleText) + theme.dim(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(titleText)))}╮`);
	const hintText = hint ? ` ${hint} ` : "";
	const bottom = theme.dim("╰─") + theme.dim(hintText) + theme.dim(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(hintText)))}╯`);
	return [top, ...body.map((line) => `${theme.dim("│")} ${fit(line, inner)} ${theme.dim("│")}`), bottom];
}

export interface ComposerOptions {
	target: string;
	isWorking: () => boolean;
	onSubmit: (text: string, deliverAs: DeliverAs) => void;
	onCancel: () => void;
}

/** Prompt composer using pi's own editor component. */
export class Composer extends Container implements Focusable {
	private readonly editor: Editor;
	private readonly options: ComposerOptions;
	// Matches pi: Enter while the agent works steers; follow-up waits for it to finish.
	private mode: DeliverAs = "steer";
	private error = "";
	private _focused = false;

	constructor(tui: TUI, options: ComposerOptions) {
		super();
		this.options = options;
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (text) => this.submit(text);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	private submit(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed.startsWith("/")) {
			this.error = "Slash commands only run inside pi. Attach (a) to use them.";
			this.editor.setText(text);
			return;
		}
		this.options.onSubmit(trimmed, this.mode);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.options.onCancel();
			return;
		}
		if (matchesKey(data, Key.tab) && this.options.isWorking()) {
			this.mode = this.mode === "steer" ? "followUp" : "steer";
			return;
		}
		this.error = "";
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		const working = this.options.isWorking();
		const mode = working
			? `${theme.working("working")} · delivers as ${theme.bold(theme.accent(this.mode === "steer" ? "steer" : "follow-up"))} ${theme.dim(this.mode === "steer" ? "(after the current tool)" : "(when the run finishes)")}`
			: theme.dim("idle · starts a new turn");
		const body = [mode, ...this.editor.render(Math.max(1, width - 4))];
		if (this.error) body.push(theme.error(this.error));
		const hint = working ? "⏎ send · Tab steer/follow-up · ⇧⏎ newline · Esc cancel" : "⏎ send · ⇧⏎ newline · Esc cancel";
		return frame(`Prompt → ${this.options.target}`, body, width, hint);
	}
}

export interface PickerOptions {
	title: string;
	items: SelectItem[];
	hint?: string;
	maxVisible?: number;
	/** Extra item derived from the typed filter (e.g. "open <path>"). */
	extraItem?: (filter: string) => SelectItem | undefined;
	onSelect: (item: SelectItem) => void;
	onCancel: () => void;
}

/** Type-to-filter list. */
export class Picker extends Container implements Focusable {
	private readonly input = new Input({ prompt: "› ", placeholder: "type to filter" });
	private list: SelectList;
	private readonly options: PickerOptions;
	private _focused = false;

	constructor(options: PickerOptions) {
		super();
		this.options = options;
		this.list = this.buildList("");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private buildList(filter: string): SelectList {
		const matches = filter ? fuzzyFilter(this.options.items, filter, (item) => `${item.label} ${item.description ?? ""}`) : this.options.items;
		const extra = this.options.extraItem?.(filter);
		const list = new SelectList(extra ? [extra, ...matches] : matches, this.options.maxVisible ?? 12, selectListTheme, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 60 });
		list.onSelect = (item) => this.options.onSelect(item);
		list.onCancel = () => this.options.onCancel();
		return list;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			this.list.handleInput(data);
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (after !== before) this.list = this.buildList(after);
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		return frame(this.options.title, [...this.input.render(inner), ...this.list.render(inner)], width, this.options.hint ?? "↑↓ select · ⏎ choose · Esc cancel");
	}
}

/** y/n confirmation. */
export class Confirm implements Component {
	private readonly title: string;
	private readonly message: string;
	private readonly onAnswer: (yes: boolean) => void;

	constructor(title: string, message: string, onAnswer: (yes: boolean) => void) {
		this.title = title;
		this.message = message;
		this.onAnswer = onAnswer;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) this.onAnswer(true);
		else if (data === "n" || data === "N" || matchesKey(data, Key.escape)) this.onAnswer(false);
	}

	render(width: number): string[] {
		return frame(this.title, [...wrapTextWithAnsi(this.message, Math.max(1, width - 4)), "", `${theme.bold("y")}${theme.dim("/⏎ yes   ")}${theme.bold("n")}${theme.dim("/Esc no")}`], width);
	}
}

/** Single-line text input (rename). */
export class TextPrompt extends Container implements Focusable {
	private readonly input: Input;
	private readonly title: string;
	private _focused = false;

	constructor(title: string, initial: string, onSubmit: (value: string) => void, onCancel: () => void) {
		super();
		this.title = title;
		this.input = new Input({ prompt: "› " });
		this.input.setValue(initial);
		this.input.onSubmit = onSubmit;
		this.input.onEscape = onCancel;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		return frame(this.title, this.input.render(Math.max(1, width - 4)), width, "⏎ save · Esc cancel");
	}
}

export interface PeekOptions {
	title: string;
	lines: () => string[] | undefined;
	height: () => number;
	onKey: (data: string) => void;
}

/** Read-only mirror of a pi screen window, refreshed by the app. */
export class Peek implements Component {
	private readonly options: PeekOptions;

	constructor(options: PeekOptions) {
		this.options = options;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.options.onKey(data);
	}

	render(width: number): string[] {
		const height = Math.max(3, this.options.height() - 2);
		const source = this.options.lines();
		const body = source ? source.slice(-height).map((line) => theme.text(line)) : [theme.dim("capturing screen…")];
		while (body.length < height) body.unshift("");
		return frame(this.options.title, body, width, "live mirror · p prompt · a attach · x abort · Esc close");
	}
}

const HELP: [string, string][] = [
	["1-9 ↑↓ j k", "select session"],
	["⏎ / Esc", "detail view / back"],
	["p", "prompt (steer or follow-up while working)"],
	["x", "abort the current run"],
	["v", "peek: live read-only mirror of the pi screen"],
	["a", "attach (screen -rx; Ctrl-a d returns here)"],
	["n", "new session in a project"],
	["r", "resume a session of the selected project"],
	["c / C", "close session / close and start a new one"],
	["R", "rename session"],
	["d", "dismiss an exited session"],
	["u", "usage view (t / w / m: today, 7d, 30d)"],
	["q / Ctrl-c", "quit (sessions keep running)"],
];

export class Help implements Component {
	private readonly onClose: () => void;

	constructor(onClose: () => void) {
		this.onClose = onClose;
	}

	invalidate(): void {}

	handleInput(_data: string): void {
		this.onClose();
	}

	render(width: number): string[] {
		const body = HELP.map(([key, text]) => `${fit(theme.bold(theme.accent(key)), 14)}${theme.text(text)}`);
		body.push("");
		body.push(`${theme.working("⠹")} working  ${theme.waiting("◆")} needs you  ${theme.waiting("◆?")} stalled (no events, no CPU)  ${theme.error("✖")} error  ${theme.dim("○ ready  ◌ exited  ? no bridge")}`);
		body.push(`${theme.direct("▓")} pi process  ${theme.indirect("▒")} indirect: tools, builds (systemd units), jobs, subagents`);
		body.push(`${theme.accent("▰▱")} roadmap progress   ${theme.working("█")} working ${theme.waiting("▒")} waiting on you ${theme.dim("░")} idle (activity lane)`);
		body.push(theme.dim("$ is pi's API-equivalent cost; quota % is the subscription limit that actually applies."));
		body.push(theme.dim("Not tracked: LLM calls extensions make outside the session transcript."));
		return frame("pi-dash help", body, width, "any key closes");
	}
}
