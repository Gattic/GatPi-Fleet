// Scrollable window over Markdown text: the SAID pane in the detail view and the reader overlay.
import { Markdown } from "@earendil-works/pi-tui";
import { markdownTheme, theme } from "./theme.ts";

export interface PaneWindow {
	lines: string[];
	/** Rendered lines above and below the window. */
	above: number;
	below: number;
}

export class TextPane {
	private readonly markdown = new Markdown("", 0, 0, markdownTheme, { color: theme.text });
	private text = "";
	private offset = 0;
	private height = 1;

	/** A different text starts at its top. */
	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.offset = 0;
		this.markdown.setText(text);
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
		const all = this.markdown.render(width);
		this.height = Math.max(1, Math.min(maxHeight, all.length));
		this.offset = Math.min(this.offset, Math.max(0, all.length - this.height));
		const lines = all.slice(this.offset, this.offset + this.height);
		return { lines, above: this.offset, below: all.length - this.offset - lines.length };
	}
}
