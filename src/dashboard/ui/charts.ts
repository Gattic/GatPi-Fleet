// Small text charts. Every function returns exactly `width` visible columns.
import { LANE } from "../../manager/model/status.ts";
import { levelColor, type Paint, theme } from "./theme.ts";

const BLOCKS = " ▁▂▃▄▅▆▇█";
const SPARK = "▁▂▃▄▅▆▇█";

/** Reduce (or left-pad with NaN) `values` to `width` buckets, oldest first. */
export function downsample(values: readonly number[], width: number, mode: "avg" | "max" | "sum" = "avg"): number[] {
	if (width <= 0) return [];
	if (values.length <= width) return [...new Array<number>(width - values.length).fill(Number.NaN), ...values];
	const result: number[] = [];
	for (let column = 0; column < width; column++) {
		const start = Math.floor((column * values.length) / width);
		const end = Math.floor(((column + 1) * values.length) / width);
		let acc = mode === "max" ? Number.NEGATIVE_INFINITY : 0;
		let count = 0;
		for (let index = start; index < end; index++) {
			const value = values[index];
			if (Number.isNaN(value)) continue;
			acc = mode === "max" ? Math.max(acc, value) : acc + value;
			count++;
		}
		result.push(count === 0 ? Number.NaN : mode === "avg" ? acc / count : acc);
	}
	return result;
}

/** One-row trend; NaN renders as blank. `max` defaults to the series maximum. */
export function sparkline(values: readonly number[], width: number, max?: number, paint: Paint = theme.accent): string {
	const columns = downsample(values, width);
	const top = max ?? Math.max(0, ...columns.filter((value) => !Number.isNaN(value)));
	let out = "";
	for (const value of columns) {
		if (Number.isNaN(value)) out += " ";
		else if (top <= 0 || value <= 0) out += theme.faint(SPARK[0]);
		else out += paint(SPARK[Math.min(SPARK.length - 1, Math.round((value / top) * (SPARK.length - 1)))]);
	}
	return out;
}

/** Thin `━━━━╸━━━` meter filled to `fraction` in half cells, coloured by level. */
export function gauge(fraction: number, width: number, paint?: Paint): string {
	if (width <= 0) return "";
	const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
	const halves = Math.round(clamped * width * 2);
	const full = Math.floor(halves / 2);
	const half = halves % 2;
	const color = paint ?? levelColor(clamped);
	return color("━".repeat(full) + (half ? "╸" : "")) + theme.faint("━".repeat(width - full - half));
}

/** Direct (▓) and indirect (▒) shares of `scale` in one bar. */
export function splitBar(direct: number, indirect: number, scale: number, width: number): string {
	if (width <= 0) return "";
	const unit = scale > 0 ? width / scale : 0;
	// A non-zero share always gets at least one cell so it stays visible.
	const cells = (value: number) => (value > 0 ? Math.max(1, Math.round(value * unit)) : 0);
	const directCells = Math.min(width, cells(direct));
	const indirectCells = Math.min(width - directCells, cells(indirect));
	return theme.direct("▓".repeat(directCells)) + theme.indirect("▒".repeat(indirectCells)) + theme.faint("░".repeat(width - directCells - indirectCells));
}

export function planBar(complete: number, total: number, width: number): string {
	if (width <= 0) return "";
	const filled = total > 0 ? Math.round((complete / total) * width) : 0;
	const paint = total > 0 && complete >= total ? theme.working : theme.accent;
	return paint("▰".repeat(filled)) + theme.faint("▱".repeat(width - filled));
}

/** Two stacked series (direct below, indirect above) as `height` rows, top row first. */
export function stackedArea(direct: readonly number[], indirect: readonly number[], width: number, height: number, max: number): string[] {
	const a = downsample(direct, width);
	const b = downsample(indirect, width);
	const rows: string[] = [];
	for (let row = height - 1; row >= 0; row--) {
		let line = "";
		for (let column = 0; column < width; column++) {
			const av = Number.isNaN(a[column]) ? 0 : a[column];
			const bv = Number.isNaN(b[column]) ? 0 : b[column];
			const aEighths = max > 0 ? Math.round((av / max) * height * 8) : 0;
			const tEighths = max > 0 ? Math.round(((av + bv) / max) * height * 8) : 0;
			const lo = row * 8;
			const aFill = Math.max(0, Math.min(8, aEighths - lo));
			const tFill = Math.max(0, Math.min(8, tEighths - lo));
			if (Number.isNaN(a[column]) && Number.isNaN(b[column])) line += " ";
			else if (tFill === 0) line += row === 0 ? theme.faint("▁") : " ";
			else if (aFill === 8) line += theme.direct("█");
			else if (aFill > 0) line += tFill === 8 ? theme.indirectBg(theme.direct(BLOCKS[aFill])) : theme.direct(BLOCKS[aFill]);
			else line += theme.indirect(BLOCKS[tFill]);
		}
		rows.push(line);
	}
	return rows;
}

const LANE_CELLS: Record<number, string> = {
	[LANE.none]: " ",
	[LANE.idle]: theme.dim("░"),
	[LANE.waiting]: theme.waiting("▒"),
	[LANE.working]: theme.working("█"),
	[LANE.error]: theme.error("▓"),
};

/** Time lane: each column shows the most frequent state in its time slice. */
export function activityLane(states: readonly number[], width: number): string {
	if (width <= 0) return "";
	let out = "";
	for (let column = 0; column < width; column++) {
		const start = Math.floor((column * states.length) / width);
		const end = Math.max(start + 1, Math.floor(((column + 1) * states.length) / width));
		if (states.length < width && column < width - states.length) {
			out += " ";
			continue;
		}
		const slice = states.length < width ? [states[column - (width - states.length)]] : states.slice(start, end);
		const counts = new Map<number, number>();
		for (const state of slice) counts.set(state, (counts.get(state) ?? 0) + 1);
		let best: number = LANE.none;
		let bestCount = 0;
		for (const [state, count] of counts) {
			if (state !== LANE.none && count > bestCount) {
				best = state;
				bestCount = count;
			}
		}
		out += LANE_CELLS[best];
	}
	return out;
}

/** Horizontal bar of `value / max` over `width` cells using eighth blocks. */
export function hbar(value: number, max: number, width: number, paint: Paint = theme.accent): string {
	if (width <= 0) return "";
	const eighths = max > 0 ? Math.round((Math.max(0, value) / max) * width * 8) : 0;
	const full = Math.min(width, Math.floor(eighths / 8));
	const part = full < width ? eighths % 8 : 0;
	const bar = "█".repeat(full) + (part ? "▏▎▍▌▋▊▉"[part - 1] : "");
	return paint(bar) + " ".repeat(width - full - (part ? 1 : 0));
}

/** Thin segmented bar of shares (e.g. cost by session), each segment painted. */
export function shareBar(parts: readonly { value: number; paint: Paint }[], width: number): string {
	const total = parts.reduce((sum, part) => sum + part.value, 0);
	if (total <= 0 || width <= 0) return theme.faint("━".repeat(Math.max(0, width)));
	let out = "";
	let used = 0;
	let acc = 0;
	for (const part of parts) {
		acc += part.value;
		const end = Math.round((acc / total) * width);
		if (end > used) out += part.paint("━".repeat(end - used));
		used = end;
	}
	return out + theme.faint("━".repeat(width - used));
}

/** Spread `values` over `width` columns, each value covering an equal run (for series that span the whole chart). */
export function stretch(values: readonly number[], width: number): number[] {
	if (!values.length || values.length >= width) return [...values];
	return Array.from({ length: width }, (_, column) => values[Math.floor((column * values.length) / width)]);
}
