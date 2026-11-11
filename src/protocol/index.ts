// Wire protocol between the in-process pi bridge extension and the pi-dash
// dashboard: LF-delimited JSON over a per-process unix socket.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const PROTOCOL_VERSION = 7;

/** Directory holding one `<pid>.sock` per bridged pi process (mode 0700). */
export function socketDir(env: NodeJS.ProcessEnv = process.env): string {
	const runtimeDir = env.XDG_RUNTIME_DIR;
	return runtimeDir ? join(runtimeDir, "pi-dash") : join(tmpdir(), `pi-dash-${process.getuid?.() ?? "user"}`);
}

/** pi-dash's cache directory (`~/.cache/pi-dash`). */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-dash");
}

export function socketPath(pid: number, dir: string = socketDir()): string {
	return join(dir, `${pid}.sock`);
}

export function pidFromSocketName(name: string): number | undefined {
	const match = /^(\d+)\.sock$/.exec(name);
	return match ? Number(match[1]) : undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** input + output + cacheRead + cacheWrite, matching pi's /session total. */
	tokens: number;
	/** API-equivalent dollars as computed by pi. */
	cost: number;
}

/** Usage shape persisted by pi on assistant/toolResult messages and summaries. */
export interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 };
}

export function addUsage(totals: UsageTotals, usage: PiUsage): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	totals.input += input;
	totals.output += output;
	totals.cacheRead += cacheRead;
	totals.cacheWrite += cacheWrite;
	totals.tokens += input + output + cacheRead + cacheWrite;
	totals.cost += usage.cost?.total ?? 0;
}

export function usageTokens(usage: PiUsage): number {
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

export interface UsageMinute {
	/** Epoch minute (ms / 60000, floored). */
	minute: number;
	tokens: number;
	cost: number;
}

export type ActivityKind = "model" | "thinking" | "writing" | "tool" | "compacting" | "continuing";

export interface Activity {
	kind: ActivityKind;
	/** Tool name when kind is "tool". */
	tool?: string;
	/** Short argument summary when kind is "tool". */
	detail?: string;
	since: number;
}

export interface PlanStep {
	title: string;
	status: string;
	/** Dotted roadmap path such as "2.1.3". */
	path?: string;
}

export interface RoadmapEntry extends PlanStep {
	kind: "item" | "roadmap";
	path: string;
	/** Latest three notes, each bounded to 200 characters by the publisher. */
	notes: string[];
}

/** Display-only nested detail, bounded by the publisher to 500 entries / 64 KiB. */
export interface RoadmapViewer {
	id: string;
	updatedAt: string;
	outcomes: { complete: number; total: number; blocked: number };
	entries: RoadmapEntry[];
	totalEntries: number;
}

/** Published by the GatPi-Harness roadmap extension on the `roadmap:changed` event. */
export interface PlanSnapshot {
	title: string;
	lifecycle: string;
	complete: number;
	total: number;
	blocked: number;
	milestones: PlanStep[];
	activePath: PlanStep[];
	/** Absent when the roadmap publisher does not supply nested detail. */
	viewer?: RoadmapViewer;
}

export const ROADMAP_CHANGED_EVENT = "roadmap:changed";

/** Published by the GatPi-Harness prompt-suggestions extension: the suggested next prompt, or null. */
export const PROMPT_SUGGESTION_CHANGED_EVENT = "prompt-suggestion:changed";
/** Request the publisher's Ctrl+R retry; respond(null) accepts, respond(error) rejects synchronously. */
export const PROMPT_SUGGESTION_REQUEST_EVENT = "prompt-suggestion:request";

export interface ToolRun {
	id: string;
	name: string;
	/** One-line argument summary for the activity lane. */
	detail: string;
	/** The call's arguments as JSON, bounded by the bridge; absent from older bridges. */
	arguments?: string;
	/** Text the tool returned, bounded by the bridge; absent while it runs and from older bridges. */
	result?: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
}

export type Phase = "working" | "idle";

/** What a session is doing, for the activity lane: waiting means idle after a run (the user is up). */
export type TimelineState = "working" | "waiting" | "idle";

/** A change of state; it holds until the next entry. */
export interface TimelineEntry {
	at: number;
	state: TimelineState;
}

/** How far back the timeline reaches. */
export const TIMELINE_MS = 3_600_000;

/** A side question to the session's model about the session; it is not added to the session. */
export interface AskRun {
	id: number;
	question: string;
	askedAt: number;
	status: "answering" | "answered" | "failed";
	/** Markdown; grows while answering. */
	answer: string;
	error?: string;
	usage?: UsageTotals;
}

/** How many asks a session keeps. */
export const MAX_ASKS = 10;

/** How many earlier prompts a session offers to recall, as many as pi's editor history. */
export const MAX_PROMPTS = 100;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SessionIdentity {
	pid: number;
	sessionId: string;
	/** New random identity on every bridge start, including reload and session switch. */
	instanceId: string;
}

/** Estimated composition of a session's model context. Every part is an estimate. */
export interface ContextParts {
	system: number;
	tools: number;
	injected: number;
	user: number;
	assistant: number;
	toolResults: number;
	summary: number;
}

/**
 * The breakdown of `SessionState.context`. `tokens`, `window` and `percent` stay pi's measurement;
 * the parts come from pi's chars/4 estimator, so `unattributed` is a real residual, not noise to hide.
 */
export interface ContextBreakdown {
	parts: ContextParts;
	/** `tokens − Σ parts` when `tokens` is known; null while the total is unknown (after compaction). */
	unattributed: number | null;
	/** Whether the total came from pi or is only the projection estimate. */
	totalBasis: "measured" | "estimate";
	/** Image tokens, already counted inside their owning category; informational only. */
	imageTokens: number;
	counts: { user: number; assistant: number; toolResults: number; injected: number; imageBlocks: number };
	/** `window − reserveTokens`; null when compaction is disabled or the window is unknown. */
	compactAt: number | null;
	/** Context tokens of the latest requests, oldest first, at most 32. */
	history: number[];
	at: number;
}

export interface SessionState extends SessionIdentity {
	/** GNU screen session (`$STY`) and window hosting this pi, when inside screen. */
	sty?: string;
	window?: string;
	cwd: string;
	sessionFile?: string;
	name?: string;
	/** "provider/modelId". */
	model?: string;
	thinking?: string;
	phase: Phase;
	phaseSince: number;
	/** When the agent last settled in this process; absent until the first run completes. */
	lastSettledAt?: number;
	activity?: Activity;
	/** Coarse heartbeat (≤ every 10 s) of the latest pi event, used to detect stalls. */
	lastEventAt: number;
	lastPrompt?: string;
	/**
	 * The session's prompts to recall, oldest first. Like pi's editor history, each appears once, where it
	 * was last sent: the newest MAX_PROMPTS that fit in a size budget, whole.
	 */
	prompts: string[];
	/** Full text (Markdown, bounded) of the latest assistant reply: a message with text and no tool calls. */
	lastSaid?: string;
	/** Suggested next prompt; absent while the agent works or without the prompt-suggestions extension. */
	suggestion?: string;
	lastError?: { message: string; at: number };
	rateLimited?: { at: number; retryAfter?: string };
	context?: { tokens: number | null; window: number; percent: number | null; breakdown?: ContextBreakdown };
	usage: { direct: UsageTotals; indirect: UsageTotals };
	/** Per-minute usage (direct + indirect) for the last two hours. */
	usageMinutes: UsageMinute[];
	plan?: PlanSnapshot;
	/** Most recent tool runs, oldest first. */
	tools: ToolRun[];
	/** State changes over the last TIMELINE_MS, oldest first, starting no earlier than the pi process. */
	timeline: TimelineEntry[];
	/** Models the session can switch to ("provider/modelId"): its scoped models, else all with configured auth. */
	models: string[];
	/** Side questions asked since the session started in this process, the last MAX_ASKS, oldest first. */
	asks: AskRun[];
}

/** Top-level field replacement; `null` clears a field. */
export type SessionPatch = { [K in keyof SessionState]?: SessionState[K] | null };

export type BridgeMessage =
	| { type: "hello"; version: number }
	| { type: "snapshot"; state: SessionState }
	| { type: "patch"; changes: SessionPatch }
	| { type: "ack"; id: number; ok: boolean; error?: string }
	| { type: "bye"; reason: string };

export type DeliverAs = "steer" | "followUp";

export type Command =
	| { kind: "prompt"; text: string; deliverAs?: DeliverAs }
	| { kind: "abort" }
	| { kind: "shutdown" }
	| { kind: "reload" }
	/** Starts a fresh conversation in the same project, like pi's /new or /clear. Only while idle. */
	| { kind: "new" }
	| { kind: "suggest" }
	| { kind: "rename"; name: string }
	/** Only while idle. */
	| { kind: "compact" }
	| { kind: "model"; provider: string; id: string }
	| { kind: "thinking"; level: ThinkingLevel }
	/** Acknowledged once the answer starts; one ask at a time. */
	| { kind: "ask"; question: string };

export type ClientMessage = { type: "command"; id: number; target: SessionIdentity; command: Command };

export function sameSession(a: SessionIdentity, b: SessionIdentity): boolean {
	return a.pid === b.pid && a.sessionId === b.sessionId && a.instanceId === b.instanceId;
}

export function encodeMessage(message: BridgeMessage | ClientMessage): string {
	return `${JSON.stringify(message)}\n`;
}

const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** Splits a UTF-8 text stream on LF only (never on Unicode line separators) and parses JSON lines. */
export class LineDecoder {
	private buffer = "";

	push(chunk: string): unknown[] {
		this.buffer += chunk;
		const messages: unknown[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim()) messages.push(JSON.parse(line));
			newline = this.buffer.indexOf("\n");
		}
		if (this.buffer.length > MAX_LINE_CHARS) throw new Error("protocol line exceeds limit");
		return messages;
	}
}

/** The patch that turns `previous` into `next` under applyPatch: fields whose value is no longer the same object. */
export function diffState(previous: SessionState, next: SessionState): SessionPatch {
	const before = previous as unknown as Record<string, unknown>;
	const after = next as unknown as Record<string, unknown>;
	const changes: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (after[key] === undefined) {
			if (before[key] !== undefined) changes[key] = null;
		} else if (after[key] !== before[key]) changes[key] = after[key];
	}
	return changes as SessionPatch;
}

export function applyPatch(state: SessionState, changes: SessionPatch): SessionState {
	const next: Record<string, unknown> = { ...state };
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return next as unknown as SessionState;
}
