import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fmtCores(cores: number): string {
	return `${cores >= 10 ? cores.toFixed(0) : cores.toFixed(1)}c`;
}

export function fmtBytes(bytes: number): string {
	const gib = bytes / 1024 ** 3;
	if (gib >= 10) return `${gib.toFixed(0)}G`;
	if (gib >= 1) return `${gib.toFixed(1)}G`;
	return `${Math.round(bytes / 1024 ** 2)}M`;
}

const TOKEN_UNITS: [number, string][] = [
	[1e9, "B"],
	[1e6, "M"],
	[1e3, "k"],
];

/** Like fmtCost, three significant digits are enough: `12.3M`, `173M`. */
export function fmtTokens(tokens: number): string {
	for (const [unit, suffix] of TOKEN_UNITS) {
		if (tokens < unit) continue;
		const value = tokens / unit;
		return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${suffix}`;
	}
	return String(Math.round(tokens));
}

export function fmtCost(dollars: number): string {
	if (dollars >= 100) return dollars.toFixed(0);
	if (dollars >= 10) return dollars.toFixed(1);
	return dollars.toFixed(2);
}

export function fmtDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 10) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function shortPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export const ELLIPSIS = "…";

/** Truncate (with ellipsis) or right-pad to exactly `width` visible columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	// Measuring is much cheaper than truncating, and most cells already fit.
	const measured = visibleWidth(text);
	if (measured <= width) return text + " ".repeat(width - measured);
	const truncated = truncateToWidth(text, width, ELLIPSIS);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export function fitRight(text: string, width: number): string {
	const measured = visibleWidth(text);
	if (measured <= width) return " ".repeat(width - measured) + text;
	const truncated = truncateToWidth(text, width, ELLIPSIS);
	return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}
