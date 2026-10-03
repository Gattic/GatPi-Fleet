import { backgroundAnsi, foregroundAnsi, getTerminalColorMode, type MarkdownTheme, parseColor } from "@earendil-works/pi-tui";

const mode = getTerminalColorMode();

function fgOf(color: string): (text: string) => string {
	const code = foregroundAnsi(parseColor(color), mode);
	return (text) => (text ? `${code}${text}\x1b[39m` : text);
}

/**
 * The background resumes after resets inside the text: nested backgrounds (a chip on a bar) end with
 * one, and so does truncated text.
 */
function bgOf(color: string): (text: string) => string {
	const code = backgroundAnsi(parseColor(color), mode);
	return (text) => (text ? `${code}${text.replace(/\x1b\[(0|49)?m/g, (reset) => (reset === "\x1b[49m" ? code : `${reset}${code}`))}\x1b[49m` : text);
}

// pi's dark theme palette, so the dashboard reads as part of pi.
const blue = "okhsl(232 54% 67%)";
const violet = "okhsl(295 50% 67%)";

export const theme = {
	working: fgOf("okhsl(159 59% 67%)"),
	waiting: fgOf("okhsl(83 88% 67%)"),
	error: fgOf("okhsl(20 72% 67%)"),
	accent: fgOf(blue),
	direct: fgOf(blue),
	indirect: fgOf(violet),
	text: fgOf("okhsl(234 3% 89%)"),
	muted: fgOf("okhsl(229 6% 67%)"),
	dim: fgOf("okhsl(229 8% 52%)"),
	/** Rules, empty gauge tracks and the backdrop behind dialogs. */
	faint: fgOf("okhsl(229 8% 32%)"),
	border: fgOf("okhsl(232 40% 55%)"),
	// Dark backgrounds are tuned to stay distinct when quantized to 256 colours (grey 235, grey 237, 23, 58).
	bar: bgOf("okhsl(232 10% 18%)"),
	chip: bgOf("okhsl(232 6% 27%)"),
	selected: bgOf("okhsl(233 41% 24%)"),
	alert: bgOf("okhsl(80 70% 24%)"),
	indirectBg: bgOf(violet),
	bold: (text: string) => (text ? `\x1b[1m${text}\x1b[22m` : text),
};

export type Paint = (text: string) => string;

function sgr(on: number, off: number): Paint {
	return (text) => (text ? `\x1b[${on}m${text}\x1b[${off}m` : text);
}

/** Assistant replies are Markdown, styled the way pi shows them. */
export const markdownTheme: MarkdownTheme = {
	heading: (text) => theme.bold(theme.waiting(text)),
	link: theme.accent,
	linkUrl: theme.dim,
	code: theme.indirect,
	codeBlock: theme.working,
	codeBlockBorder: theme.dim,
	quote: theme.muted,
	quoteBorder: theme.dim,
	hr: theme.dim,
	listBullet: theme.indirect,
	bold: theme.bold,
	italic: sgr(3, 23),
	strikethrough: sgr(9, 29),
	underline: sgr(4, 24),
};

/** Green under 60 %, amber under 85 %, red above. */
export function levelColor(fraction: number): Paint {
	if (fraction >= 0.85) return theme.error;
	if (fraction >= 0.6) return theme.waiting;
	return theme.working;
}

/** `key label  key label` hints, as in the footer and dialog borders. */
export function keyHints(hints: readonly (readonly [string, string])[]): string {
	return hints.map(([key, label]) => `${theme.bold(theme.accent(key))} ${theme.dim(label)}`).join("  ");
}

/** A key drawn as a button, for dialog answers. */
export function keycap(key: string): string {
	return theme.chip(theme.bold(theme.text(` ${key} `)));
}
