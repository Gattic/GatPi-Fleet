// Scrollable window over text: Markdown (the SAID pane in the detail view and the reply reader) or plain
// command output.
import { Markdown, Text } from "@earendil-works/pi-tui";
import { markdownTheme, theme } from "./theme.ts";

export interface PaneWindow {
	lines: string[];
	/** Rendered lines above and below the window. */
	above: number;
	below: number;
}

export class TextPane {
	private readonly plain: boolean;
	private readonly content: Markdown | Text;
	private text = "";
	private offset = 0;
	private height = 1;

	/** `plain` shows the text as is (tabs expanded) instead of rendering it as Markdown. */
	constructor(plain = false) {
		this.plain = plain;
		this.content = plain ? new Text("", 0, 0) : new Markdown("", 0, 0, markdownTheme, { color: theme.text });
	}

	/** A different text starts at its top, unless `keepPosition` (a text that grows). */
	setText(text: string, keepPosition = false): void {
		if (text === this.text) return;
		this.text = text;
		if (!keepPosition) this.offset = 0;
		// Markdown applies the default text color itself; plain text gets the same color here.
		this.content.setText(this.plain ? theme.text(text) : text);
	}

	/** Positive values scroll down; the next render clamps to the text. */
	scrollBy(lines: number): void {
		this.offset = Math.max(0, this.offset + lines);
	}

	/** Scroll by the last rendered height, keeping one line of context. */
	page(direction: -1 | 1): void {
		this.scrollBy(direction * Math.max(1, this.height - 1));
	}

	scrollTo(position: "top" | "end"): void {
		this.offset = position === "top" ? 0 : Number.MAX_SAFE_INTEGER;
	}

	/** Up to `maxHeight` lines of the text wrapped to `width`, from the scroll position. */
	render(width: number, maxHeight: number): PaneWindow {
		const all = this.content.render(width);
		this.height = Math.max(1, Math.min(maxHeight, all.length));
		this.offset = Math.min(this.offset, Math.max(0, all.length - this.height));
		const lines = all.slice(this.offset, this.offset + this.height);
		return { lines, above: this.offset, below: all.length - this.offset - lines.length };
	}
}
