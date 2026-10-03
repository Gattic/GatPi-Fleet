import { backgroundAnsi, foregroundAnsi, getTerminalColorMode, parseColor } from "@earendil-works/pi-tui";

const mode = getTerminalColorMode();

function fgOf(hex: string): (text: string) => string {
	const code = foregroundAnsi(parseColor(hex), mode);
	return (text) => (text ? `${code}${text}\x1b[39m` : text);
}

function bgOf(hex: string): (text: string) => string {
	const code = backgroundAnsi(parseColor(hex), mode);
	return (text) => (text ? `${code}${text}\x1b[49m` : text);
}

export const theme = {
	working: fgOf("#5fd787"),
	waiting: fgOf("#ffaf00"),
	error: fgOf("#ff5f5f"),
	accent: fgOf("#5fafff"),
	direct: fgOf("#5fafff"),
	indirect: fgOf("#af87ff"),
	text: fgOf("#d0d0d0"),
	muted: fgOf("#a8a8a8"),
	dim: fgOf("#6c6c6c"),
	bar: bgOf("#26303b"),
	selected: bgOf("#303a46"),
	alert: bgOf("#4a3a10"),
	indirectBg: bgOf("#af87ff"),
	bold: (text: string) => (text ? `\x1b[1m${text}\x1b[22m` : text),
};

export type Paint = (text: string) => string;

/** Green under 60 %, amber under 85 %, red above. */
export function levelColor(fraction: number): Paint {
	if (fraction >= 0.85) return theme.error;
	if (fraction >= 0.6) return theme.waiting;
	return theme.working;
}
