// Modal overlays: prompt composer, ask view, filterable picker, confirm, text input, peek, reader, help.
import {
	type Component,
	Container,
	Editor,
	type EditorTheme,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AskRun, DeliverAs } from "../../protocol/index.ts";
import type { HermesAdviceCard, HermesAdviceReview } from "../hermes/advisor.ts";
import { ELLIPSIS, fit, fmtCost, fmtDuration, fmtTokens } from "./format.ts";
import { TextPane } from "./text-pane.ts";
import { keycap, keyHints, theme } from "./theme.ts";

const selectListTheme: SelectListTheme = {
	selectedPrefix: (text) => theme.accent(text),
	selectedText: (text) => theme.bold(theme.accent(text)),
	description: (text) => theme.dim(text),
	scrollInfo: (text) => theme.dim(text),
	noMatch: (text) => theme.dim(text),
};

const editorTheme: EditorTheme = { borderColor: (text) => theme.faint(text), selectList: selectListTheme };

/** Columns between a frame's border and its content, on each side. */
const PAD = 2;

/** Content width inside a frame of `width` columns. */
function frameInner(width: number): number {
	return Math.max(1, width - 2 - 2 * PAD);
}

/** Text set into a border line, truncated to leave room for the corners. */
function inset(text: string, width: number): string {
	return text ? fit(` ${text} `, Math.min(Math.max(0, width - 4), visibleWidth(text) + 2)) : "";
}

/** Rounded box with the title in the top border and key hints in the bottom one. */
export function frame(title: string, body: readonly string[], width: number, hint = ""): string[] {
	const inner = frameInner(width);
	const titleText = theme.bold(theme.text(inset(title, width)));
	const top = theme.border("╭─") + titleText + theme.border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(titleText)))}╮`);
	const hintText = inset(hint, width);
	const bottom = theme.border("╰─") + hintText + theme.border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(hintText)))}╯`);
	const pad = " ".repeat(PAD);
	return [top, ...body.map((line) => `${theme.border("│")}${pad}${fit(line, inner)}${pad}${theme.border("│")}`), bottom];
}

/** A section label in the left gutter of a dialog row. */
function gutter(label: string, width: number): string {
	return theme.dim(fit(label, width));
}

export interface ComposerOptions {
	target: string;
	isWorking: () => boolean;
	/** The session's suggested next prompt, offered while idle and the editor is empty. */
	suggestion: () => string | undefined;
	initialText?: string;
	initialMode?: DeliverAs;
	onSubmit: (text: string, deliverAs: DeliverAs) => void;
	onCancel: () => void;
}

/** Prompt composer using pi's own editor component. */
export class Composer extends Container implements Focusable {
	private readonly editor: Editor;
	private readonly options: ComposerOptions;
	// Matches pi: Enter while the agent works steers; follow-up waits for it to finish.
	private mode: DeliverAs;
	private error = "";
	private _focused = false;

	constructor(tui: TUI, options: ComposerOptions) {
		super();
		this.options = options;
		this.mode = options.initialMode ?? "steer";
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (text) => this.submit(text);
		if (options.initialText) this.editor.setText(options.initialText);
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

	private visibleSuggestion(): string | undefined {
		if (this.options.isWorking() || this.editor.getText()) return undefined;
		return this.options.suggestion();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.options.onCancel();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const suggestion = this.visibleSuggestion();
			if (suggestion) {
				this.editor.setText(suggestion);
				return;
			}
			if (this.options.isWorking()) {
				this.mode = this.mode === "steer" ? "followUp" : "steer";
				return;
			}
		}
		this.error = "";
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		const inner = frameInner(width);
		const working = this.options.isWorking();
		const mode = working
			? `${theme.working("●")} ${theme.text("working")} ${theme.dim("· delivers as")} ${theme.bold(theme.accent(this.mode === "steer" ? "steer" : "follow-up"))} ${theme.dim(this.mode === "steer" ? "(after the current tool)" : "(when the run finishes)")}`
			: `${theme.dim("○")} ${theme.text("idle")} ${theme.dim("· starts a new turn")}`;
		const body = [mode, ...this.editor.render(inner)];
		const suggestion = this.visibleSuggestion();
		if (suggestion) {
			const wrapped = suggestion.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, inner - 2)));
			body.push(...wrapped.map((line, index) => `${theme.dim(index === 0 ? "↳ " : "  ")}${theme.muted(line)}`));
		}
		if (this.error) body.push(theme.error(`✖ ${this.error}`));
		const hints: [string, string][] = working ? [["⏎", "send"], ["Tab", "steer/follow-up"]] : [["⏎", "send"], ...(suggestion ? [["Tab", "accept suggestion"] as [string, string]] : [])];
		return frame(`Prompt → ${this.options.target}`, body, width, keyHints([...hints, ["⇧⏎", "newline"], ["Esc", "cancel"]]));
	}
}

export interface AskViewOptions {
	target: string;
	asks: () => readonly AskRun[];
	height: () => number;
	/** Resolves once the session has started answering; rejects with its reason. */
	onAsk: (question: string) => Promise<void>;
	onClose: () => void;
}

const ASK_INTRO =
	"Ask this session about its work: what it is doing, why, what is left. It answers from its own context with its own model. Nothing is added to the session, and its run is not interrupted.";

function askFooter(ask: AskRun, now: number): string {
	if (ask.status === "answering") return "answering…";
	if (ask.status === "failed") return `✖ ${ask.error ?? "failed"}`;
	const parts = [`${fmtDuration(now - ask.askedAt)} ago`];
	const usage = ask.usage;
	if (usage?.tokens) parts.push(`${fmtTokens(usage.tokens)} tokens, ${Math.round((100 * usage.cacheRead) / usage.tokens)}% from cache`);
	if (usage?.cost) parts.push(`$${fmtCost(usage.cost)}`);
	return parts.join(" · ");
}

/** The asks as Markdown, oldest first: each question quoted, its answer, then its status. */
function askThread(asks: readonly AskRun[], now: number): string {
	if (!asks.length) return `*${ASK_INTRO}*`;
	return asks
		.map((ask) => {
			const question = ask.question
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
			return [question, ask.answer, `*${askFooter(ask, now)}*`].filter(Boolean).join("\n\n");
		})
		.join("\n\n---\n\n");
}

/** Full-screen thread of a session's side questions, with pi's editor for the next one. */
export class AskView implements Component, Focusable {
	private readonly editor: Editor;
	private readonly pane = new TextPane();
	private readonly options: AskViewOptions;
	// Stay on the newest answer until the reader scrolls up.
	private follow = true;
	private sending = false;
	private error = "";
	private _focused = false;

	constructor(tui: TUI, options: AskViewOptions) {
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

	invalidate(): void {
		this.editor.invalidate();
	}

	private answering(): boolean {
		return this.sending || this.options.asks().at(-1)?.status === "answering";
	}

	private submit(text: string): void {
		const question = text.trim();
		if (!question) return;
		if (this.answering()) {
			this.error = "still answering the previous question";
			this.editor.setText(text);
			return;
		}
		this.sending = true;
		this.error = "";
		this.follow = true;
		this.options.onAsk(question).then(
			() => {
				this.sending = false;
			},
			(error: Error) => {
				this.sending = false;
				this.error = error.message;
				if (!this.editor.getText()) this.editor.setText(question);
			},
		);
	}

	private scroll(lines: number): void {
		this.pane.scrollBy(lines);
		if (lines < 0) this.follow = false;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) return this.options.onClose();
		if (matchesKey(data, Key.pageUp)) {
			this.pane.page(-1);
			this.follow = false;
			return;
		}
		if (matchesKey(data, Key.pageDown)) return this.pane.page(1);
		// With nothing typed, the arrows scroll the thread instead of moving the cursor.
		if (!this.editor.getText() && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) return this.scroll(matchesKey(data, Key.up) ? -1 : 1);
		this.error = "";
		this.editor.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		this.scroll(event.wheelDelta ?? 0);
		return { handled: true };
	}

	private status(): string {
		if (this.error) return theme.error(`✖ ${this.error}`);
		if (this.sending) return `${theme.working("◌")} ${theme.text("asking…")}`;
		if (this.answering()) return `${theme.working("●")} ${theme.text("answering")} ${theme.dim("· the next question waits for this answer")}`;
		return `${theme.dim("○")} ${theme.dim("answers come from the session's own model and context")}`;
	}

	render(width: number): string[] {
		const inner = frameInner(width);
		const height = Math.max(4, this.options.height() - 2);
		const editor = this.editor.render(inner);
		const threadHeight = Math.max(1, height - editor.length - 1);
		this.pane.setText(askThread(this.options.asks(), Date.now()), true);
		if (this.follow) this.pane.scrollTo("end");
		const view = this.pane.render(inner, threadHeight);
		if (view.below === 0) this.follow = true;
		// The thread sits on the editor, like a chat.
		const body = [...view.lines];
		while (body.length < threadHeight) body.unshift("");
		body.push(this.status(), ...editor);
		const total = view.above + view.lines.length + view.below;
		const position = total > view.lines.length ? `${theme.muted(`${view.above + 1}–${view.above + view.lines.length}/${total}`)}  ` : "";
		return frame(`ask · ${this.options.target}`, body, width, `${position}${keyHints([["⏎", "ask"], ["PgUp PgDn", "scroll"], ["⇧⏎", "newline"], ["Esc", "close"]])}`);
	}
}

export interface HermesAdviceViewOptions {
	review: () => HermesAdviceReview | undefined;
	loading: () => boolean;
	error: () => string | undefined;
	height: () => number;
	onRefresh: () => void;
	onExecute: (card: HermesAdviceCard) => void;
	onDismiss: (card: HermesAdviceCard) => void;
	onClose: () => void;
}

const ADVICE_ICON: Record<HermesAdviceCard["severity"], string> = { critical: "✖", warning: "⚠", suggestion: "◆", info: "·" };

function advicePaint(card: HermesAdviceCard): (text: string) => string {
	if (card.severity === "critical") return theme.error;
	if (card.severity === "warning") return theme.waiting;
	if (card.severity === "suggestion") return theme.accent;
	return theme.dim;
}

function adviceAction(action: HermesAdviceCard["action"]): string {
	if (!action) return "no action";
	switch (action.kind) {
		case "ask":
			return "ask session";
		case "prompt":
			return action.deliverAs === "followUp" ? "queue follow-up" : action.deliverAs === "steer" ? "steer session" : "send prompt";
		case "compact":
			return "compact session";
		case "notify":
			return "show notification";
		case "memory_proposal":
			return "record memory proposal";
		case "skill_proposal":
			return "record skill proposal";
	}
}

/** Full-screen-ish Hermes manager advice cards. */
export class HermesAdviceView implements Component {
	private selected = 0;
	private readonly options: HermesAdviceViewOptions;

	constructor(options: HermesAdviceViewOptions) {
		this.options = options;
	}

	invalidate(): void {}

	private cards(): readonly HermesAdviceCard[] {
		return this.options.review()?.cards ?? [];
	}

	private selectedCard(): HermesAdviceCard | undefined {
		const cards = this.cards();
		if (!cards.length) return undefined;
		this.selected = Math.max(0, Math.min(cards.length - 1, this.selected));
		return cards[this.selected];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "H") return this.options.onClose();
		if (data === "r") return this.options.onRefresh();
		if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(Math.max(0, this.cards().length - 1), this.selected + 1);
			return;
		}
		const card = this.selectedCard();
		if (!card) return;
		if (matchesKey(data, Key.enter)) return this.options.onExecute(card);
		if (data === "d") return this.options.onDismiss(card);
	}

	render(width: number): string[] {
		const inner = frameInner(width);
		const review = this.options.review();
		const loading = this.options.loading();
		const status = loading
			? `${theme.working("◌")} ${theme.text("asking Hermes…")}`
			: review
				? `${theme.text(review.source === "hermes" ? "Hermes" : "local rules")} ${theme.dim(`· ${fmtDuration(Date.now() - review.generatedAt)} ago${review.error ? ` · ${review.error}` : ""}`)}`
				: theme.dim("No review yet.");
		const error = this.options.error();
		const body: string[] = [status];
		if (error) body.push(theme.error(`✖ ${error}`));
		const cards = this.cards();
		if (!cards.length) {
			body.push("", theme.dim("No advice cards yet. Press r to refresh."));
		} else {
			body.push("");
			for (const [index, card] of cards.entries()) {
				const selected = index === this.selected;
				const paint = advicePaint(card);
				const prefix = selected ? theme.accent("▌") : " ";
				const text = `${prefix}${paint(ADVICE_ICON[card.severity])} ${theme.text(card.title)} ${theme.dim(card.targetLabel ? `· ${card.targetLabel}` : "")} ${theme.dim(`· ${adviceAction(card.action)}`)}`;
				body.push(selected ? theme.selected(fit(text, inner)) : fit(text, inner));
			}
			const card = this.selectedCard();
			if (card) {
				body.push("", theme.bold(theme.text(card.title)));
				body.push(...card.body.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner)));
				if (card.evidence.length) {
					body.push(theme.dim("Evidence"));
					for (const item of card.evidence) body.push(...wrapTextWithAnsi(`${theme.dim("• ")}${theme.muted(item)}`, inner));
				}
				body.push(`${theme.dim("Action")} ${theme.text(adviceAction(card.action))}`);
			}
		}
		const maxBody = Math.max(4, this.options.height() - 2);
		const shown = body.slice(0, maxBody);
		return frame("Hermes advisor", shown, width, keyHints([["↑↓", "select"], ["⏎", "act"], ["d", "dismiss"], ["r", "refresh"], ["Esc", "close"]]));
	}
}

export interface PickerOptions {
	title: string;
	items: SelectItem[];
	maxVisible?: number;
	/** Extra item derived from the typed filter (e.g. "open <path>"). */
	extraItem?: (filter: string) => SelectItem | undefined;
	onSelect: (item: SelectItem) => void;
	onCancel: () => void;
}

/** Type-to-filter list. */
export class Picker extends Container implements Focusable {
	private readonly input = new Input({ prompt: theme.accent("› "), placeholder: "type to filter", placeholderStyle: theme.dim });
	private list: SelectList;
	private count = 0;
	private readonly options: PickerOptions;
	private _focused = false;
	// The selected item is a full-width bar, so its style needs the width being rendered.
	private width = 0;
	private readonly listTheme: SelectListTheme = {
		...selectListTheme,
		selectedText: (text) => theme.selected(fit(theme.bold(theme.text(text)), this.width)),
	};

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
		const items = extra ? [extra, ...matches] : matches;
		this.count = items.length;
		const list = new SelectList(items, this.options.maxVisible ?? 12, this.listTheme, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 48, truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, ELLIPSIS) });
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
		const inner = frameInner(width);
		this.width = inner;
		const list = this.count ? this.list.render(inner) : [theme.dim(this.input.getValue() ? "  no matches" : "  nothing to choose from")];
		return frame(this.options.title, [...this.input.render(inner), theme.faint("─".repeat(inner)), ...list], width, keyHints([["↑↓", "select"], ["⏎", "choose"], ["Esc", "cancel"]]));
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
		const message = wrapTextWithAnsi(this.message, frameInner(width)).map((line) => theme.text(line));
		const answers = `${keycap("y")} ${theme.text("yes")}    ${keycap("n")} ${theme.muted("no")}`;
		return frame(this.title, ["", ...message, "", answers, ""], width, keyHints([["⏎", "yes"], ["Esc", "no"]]));
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
		this.input = new Input({ prompt: theme.accent("› ") });
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
		return frame(this.title, this.input.render(frameInner(width)), width, keyHints([["⏎", "save"], ["Esc", "cancel"]]));
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
		return frame(this.options.title, body, width, `${theme.working("●")} ${theme.dim("live")}  ${keyHints([["p", "prompt"], ["a", "attach"], ["x", "abort"], ["Esc", "close"]])}`);
	}
}

export interface ReaderOptions {
	title: string;
	/** Read on every render, so the reader follows new replies. */
	text: () => string;
	/** Show the text as is (command output) instead of rendering it as Markdown. */
	plain?: boolean;
	height: () => number;
	/** Hints for the keys `onKey` handles. */
	keys: [string, string][];
	/** Keys the reader does not use for scrolling. */
	onKey: (data: string) => void;
}

/** Full-screen, scrollable text. */
export class Reader implements Component {
	private readonly pane: TextPane;
	private readonly options: ReaderOptions;

	constructor(options: ReaderOptions) {
		this.options = options;
		this.pane = new TextPane(options.plain);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) || data === "k") this.pane.scrollBy(-1);
		else if (matchesKey(data, Key.down) || data === "j") this.pane.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.pane.page(-1);
		else if (matchesKey(data, Key.pageDown) || data === " ") this.pane.page(1);
		else if (matchesKey(data, Key.home) || data === "g") this.pane.scrollTo("top");
		else if (matchesKey(data, Key.end) || data === "G") this.pane.scrollTo("end");
		else this.options.onKey(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		this.pane.scrollBy(event.wheelDelta ?? 0);
		return { handled: true };
	}

	render(width: number): string[] {
		const height = Math.max(1, this.options.height() - 2);
		this.pane.setText(this.options.text());
		const view = this.pane.render(frameInner(width), height);
		const body = [...view.lines];
		while (body.length < height) body.push("");
		const total = view.above + view.lines.length + view.below;
		const position = total > view.lines.length ? `${theme.muted(`${view.above + 1}–${view.above + view.lines.length}/${total}`)}  ` : "";
		return frame(this.options.title, body, width, `${position}${keyHints([["↑↓ PgUp PgDn", "scroll"], ...this.options.keys])}`);
	}
}

const HELP: [string, [string, string][]][] = [
	[
		"NAVIGATE",
		[
			["1-9 ↑↓ j k", "select session"],
			["Tab", "next session that needs you (longest waiting first)"],
			["⏎ / Esc", "detail view / back"],
			["u", "usage view (t / w / m: today, 7d, 30d; $: cost or tokens)"],
			["q / Ctrl-c", "quit (sessions keep running)"],
		],
	],
	[
		"SESSION",
		[
			["p", "prompt (steer or follow-up while working; Tab takes the suggestion)"],
			["i", "ask the session about its work; nothing is added to the session"],
			["H", "Hermes advisor: cross-session action cards with feedback"],
			["s", "read the latest reply full screen (or click SAID)"],
			["PgUp PgDn", "scroll SAID in the detail view (or mouse wheel)"],
			["x", "abort the current run"],
			["v", "peek: live read-only mirror of the pi screen"],
			["a", "attach (screen -rx; Ctrl-a d returns here)"],
			["M / T", "switch model / thinking level"],
			["Z", "compact the conversation (when idle)"],
			["R", "rename session"],
		],
	],
	[
		"MANAGE",
		[
			["n", "new session in a project"],
			["r", "resume a session of the selected project"],
			["c / C", "close session / close and start a new one"],
			["d", "dismiss an exited session"],
		],
	],
];

const GUTTER = 10;
const KEY_COLUMN = 13;

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
		const body: string[] = [];
		for (const [section, keys] of HELP) {
			keys.forEach(([key, text], index) => body.push(`${gutter(index === 0 ? section : "", GUTTER)}${fit(theme.bold(theme.accent(key)), KEY_COLUMN)}${theme.text(text)}`));
		}
		body.push("");
		const legend: [string, string][] = [
			["STATES", `${theme.working("⠹")} working  ${theme.waiting("◆")} needs you  ${theme.waiting("◆?")} stalled (no events, no CPU)  ${theme.error("✖")} error  ${theme.dim("○ ready  ◌ exited  ? no bridge")}`],
			["BARS", `${theme.direct("▓")} pi process  ${theme.indirect("▒")} indirect: tools, builds (systemd units), jobs, subagents`],
			["", `${theme.accent("▰▱")} roadmap progress   ${theme.working("█")} working ${theme.waiting("▒")} waiting on you ${theme.dim("░")} idle (activity lane)`],
			["COLUMNS", `${theme.text("CTX")} ${theme.muted("context used")}   ${theme.text("$")} ${theme.muted("API-equivalent cost, or tokens (173Mt) for unpriced models")}`],
			["", `${theme.text("BG")} ${theme.muted("background work:")} ${theme.text("j")} ${theme.muted("bg_run jobs,")} ${theme.text("s")} ${theme.muted("subagents")}`],
			["NOTES", theme.muted("$ is pi's API-equivalent cost; quota % is the subscription limit that actually applies.")],
			["", theme.muted("Not tracked: LLM calls extensions make outside the session transcript.")],
		];
		for (const [section, text] of legend) body.push(`${gutter(section, GUTTER)}${text}`);
		return frame("pi-dash help", body, width, theme.dim("any key closes"));
	}
}
