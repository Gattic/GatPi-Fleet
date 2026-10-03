import type { Activity, SessionState } from "../../protocol/index.ts";
import { LANE, type LaneState } from "../ui/charts.ts";

export type StatusKind = "working" | "rate-limited" | "stalled" | "needs-you" | "ready" | "error" | "connecting" | "exited" | "unbridged";

export interface Status {
	kind: StatusKind;
	/** Short state description, e.g. "bash", "thinking", "needs you". */
	label: string;
	/** Start of the current state, for the timer. */
	since?: number;
}

export interface StatusInput {
	bridge?: SessionState;
	connected: boolean;
	exitedAt?: number;
	/** Total (direct + indirect) CPU cores in the latest sample. */
	cpu: number;
}

/** Working with no pi event for this long and no CPU activity is reported as stalled (often a blocking dialog). */
export const STALL_MS = 180_000;
const STALL_CPU = 0.05;
const RATE_LIMIT_MS = 120_000;

function activityLabel(activity: Activity | undefined): string {
	switch (activity?.kind) {
		case "tool":
			return activity.tool ?? "tool";
		case "thinking":
			return "thinking";
		case "writing":
			return "writing";
		case "compacting":
			return "compacting";
		case "continuing":
			return "continuing";
		default:
			return "model";
	}
}

export function deriveStatus(input: StatusInput, now: number): Status {
	const { bridge } = input;
	if (input.exitedAt !== undefined) return { kind: "exited", label: "exited", since: input.exitedAt };
	if (!bridge) return { kind: "unbridged", label: "no bridge" };
	if (!input.connected) return { kind: "connecting", label: "reconnecting" };
	if (bridge.phase === "working") {
		if (bridge.rateLimited && now - bridge.rateLimited.at < RATE_LIMIT_MS) return { kind: "rate-limited", label: "429 rate limited", since: bridge.rateLimited.at };
		if (now - bridge.lastEventAt > STALL_MS && input.cpu < STALL_CPU) return { kind: "stalled", label: "stalled?", since: bridge.lastEventAt };
		return { kind: "working", label: activityLabel(bridge.activity), since: bridge.activity?.since ?? bridge.phaseSince };
	}
	if (bridge.lastError) return { kind: "error", label: bridge.lastError.message, since: bridge.lastError.at };
	if (bridge.lastSettledAt !== undefined) return { kind: "needs-you", label: "needs you", since: bridge.lastSettledAt };
	return { kind: "ready", label: "ready", since: bridge.phaseSince };
}

export function laneState(status: Status): LaneState {
	switch (status.kind) {
		case "working":
		case "rate-limited":
		case "stalled":
			return LANE.working;
		case "needs-you":
			return LANE.waiting;
		case "error":
			return LANE.error;
		case "ready":
		case "connecting":
			return LANE.idle;
		default:
			return LANE.none;
	}
}

/** States that deserve the user's attention when newly entered. */
export function isAlert(kind: StatusKind): boolean {
	return kind === "needs-you" || kind === "error" || kind === "stalled";
}
