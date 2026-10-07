import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { DeliverAs } from "../../protocol/index.ts";
import { rowCpu, rowCwd, rowLabel, type Store } from "../../manager/model/store.ts";

export type HermesAdviceSeverity = "info" | "suggestion" | "warning" | "critical";
export type HermesAdviceSource = "local" | "hermes";

export type HermesCardAction =
	| { kind: "ask"; pid: number; question: string }
	| { kind: "prompt"; pid: number; text: string; deliverAs?: DeliverAs }
	| { kind: "compact"; pid: number }
	| { kind: "notify"; message: string }
	| { kind: "memory_proposal"; text: string }
	| { kind: "skill_proposal"; title: string; body: string };

export interface HermesAdviceCard {
	id: string;
	severity: HermesAdviceSeverity;
	title: string;
	body: string;
	evidence: string[];
	source: HermesAdviceSource;
	targetPid?: number;
	targetLabel?: string;
	action?: HermesCardAction;
}

export interface HermesSessionSnapshot {
	pid: number;
	slot?: number;
	label: string;
	cwdName?: string;
	status: { kind: string; label: string; sinceMs?: number };
	connected: boolean;
	exited: boolean;
	phase?: string;
	activity?: { kind: string; tool?: string; detail?: string; sinceMs?: number };
	contextPercent?: number;
	plan?: { title: string; lifecycle: string; activePath: string[]; complete: number; total: number };
	suggestion?: string;
	lastError?: string;
	usage: { tokens: number; cost: number };
	resources?: { cpuCores: number; memoryBytes: number; background: number };
}

export interface HermesSnapshot {
	generatedAt: string;
	totals: { sessions: number; working: number; waiting: number; errors: number; stalled: number };
	sessions: HermesSessionSnapshot[];
}

export type HermesFeedbackKind = "shown" | "dismissed" | "accepted" | "executed" | "failed";

export interface HermesFeedbackEvent {
	at?: string;
	kind: HermesFeedbackKind;
	cardId: string;
	cardTitle: string;
	source: HermesAdviceSource;
	actionKind?: HermesCardAction["kind"];
	targetPid?: number;
	targetLabel?: string;
	detail?: string;
}

export interface HermesAdviceReview {
	generatedAt: number;
	snapshotAt: string;
	source: HermesAdviceSource;
	cards: HermesAdviceCard[];
	feedbackSummary: string[];
	error?: string;
}

export interface HermesAdvisorClient {
	review(snapshot: HermesSnapshot): Promise<HermesAdviceReview>;
	recordFeedback(event: HermesFeedbackEvent): Promise<void>;
}

export interface HermesAdvisorOptions {
	ledgerPath: string;
	command?: string;
	timeoutMs?: number;
	maxCards?: number;
}

const DEFAULT_TIMEOUT_MS = 18_000;
const DEFAULT_MAX_CARDS = 8;
const TEXT_LIMIT = 900;
const EVIDENCE_LIMIT = 160;
const SUMMARY_EVENTS = 80;

function clip(text: string, limit = TEXT_LIMIT): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function hashId(prefix: string, parts: readonly unknown[]): string {
	const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
	return `${prefix}_${hash}`;
}

function durationText(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function actionKind(action: HermesCardAction | undefined): HermesCardAction["kind"] | undefined {
	return action?.kind;
}

function card(
	severity: HermesAdviceSeverity,
	title: string,
	body: string,
	evidence: string[],
	session?: HermesSessionSnapshot,
	action?: HermesCardAction,
): HermesAdviceCard {
	return {
		id: hashId("local", [severity, title, session?.pid, action]),
		severity,
		title: clip(title, 120),
		body: clip(body),
		evidence: evidence.map((item) => clip(item, EVIDENCE_LIMIT)).slice(0, 4),
		source: "local",
		targetPid: session?.pid,
		targetLabel: session?.label,
		action,
	};
}

export function buildHermesSnapshot(store: Store, now: number = Date.now()): HermesSnapshot {
	const sessions = store.ordered().map((row): HermesSessionSnapshot => {
		const bridge = row.bridge;
		const cwd = rowCwd(row);
		const spend = bridge ? { tokens: bridge.usage.direct.tokens + bridge.usage.indirect.tokens, cost: bridge.usage.direct.cost + bridge.usage.indirect.cost } : { tokens: 0, cost: 0 };
		const resources = row.resources
			? {
					cpuCores: rowCpu(row),
					memoryBytes: row.resources.directMem + row.resources.indirectMem,
					background: row.resources.background.length,
				}
			: undefined;
		const activity = bridge?.activity
			? {
					kind: bridge.activity.kind,
					tool: bridge.activity.tool,
					detail: bridge.activity.detail ? clip(bridge.activity.detail, 120) : undefined,
					sinceMs: Math.max(0, now - bridge.activity.since),
				}
			: undefined;
		return {
			pid: row.pid,
			slot: row.slot,
			label: rowLabel(row),
			cwdName: cwd ? basename(cwd) : undefined,
			status: { kind: row.status.kind, label: row.status.label, sinceMs: row.status.since === undefined ? undefined : Math.max(0, now - row.status.since) },
			connected: row.connected,
			exited: row.exitedAt !== undefined,
			phase: bridge?.phase,
			activity,
			contextPercent: bridge?.context?.percent === null ? undefined : bridge?.context?.percent,
			plan: bridge?.plan
				? {
						title: clip(bridge.plan.title, 160),
						lifecycle: bridge.plan.lifecycle,
						activePath: bridge.plan.activePath.map((step) => clip(step.title, 120)),
						complete: bridge.plan.complete,
						total: bridge.plan.total,
					}
				: undefined,
			suggestion: bridge?.suggestion ? clip(bridge.suggestion, 500) : undefined,
			lastError: bridge?.lastError?.message ? clip(bridge.lastError.message, 240) : undefined,
			usage: spend,
			resources,
		};
	});
	return {
		generatedAt: new Date(now).toISOString(),
		totals: {
			sessions: sessions.length,
			working: sessions.filter((session) => session.status.kind === "working" || session.status.kind === "rate-limited").length,
			waiting: sessions.filter((session) => session.status.kind === "needs-you").length,
			errors: sessions.filter((session) => session.status.kind === "error").length,
			stalled: sessions.filter((session) => session.status.kind === "stalled").length,
		},
		sessions,
	};
}

export function deriveLocalCards(snapshot: HermesSnapshot): HermesAdviceCard[] {
	const cards: HermesAdviceCard[] = [];
	for (const session of snapshot.sessions) {
		const label = session.slot ? `${session.slot} ${session.label}` : session.label;
		const statusAge = durationText(session.status.sinceMs);
		const active = session.plan?.activePath.at(-1);
		const goal = active ? ` Active roadmap leaf: ${active}.` : "";
		if (session.status.kind === "stalled") {
			cards.push(
				card(
					"critical",
					`${label} looks stalled`,
					`Ask the session to explain whether it is blocked and what intervention it needs.${goal}`,
					[`Status has been stalled${statusAge ? ` for ${statusAge}` : ""}.`, session.activity?.tool ? `Current tool: ${session.activity.tool}.` : "No current tool reported."],
					session,
					{ kind: "ask", pid: session.pid, question: "Are you stuck or waiting on something? Summarize the current state, what is blocking progress, and the next operator action you need." },
				),
			);
		}
		if (session.status.kind === "error") {
			cards.push(
				card(
					"warning",
					`${label} ended in an error`,
					"Ask for a concise failure summary before deciding whether to restart, steer, or inspect logs.",
					[`Error: ${session.lastError ?? session.status.label}.`, statusAge ? `Error age: ${statusAge}.` : "Error age unknown."],
					session,
					{ kind: "ask", pid: session.pid, question: "Summarize the latest error, the likely cause, and the smallest next fix or diagnostic step. Do not continue the task." },
				),
			);
		}
		if (session.status.kind === "rate-limited") {
			cards.push(
				card(
					"info",
					`${label} is rate limited`,
					"Avoid piling on more prompts until the provider retry window clears, unless the work is urgent.",
					[`Status: ${session.status.label}.`, statusAge ? `Retrying for ${statusAge}.` : "No retry age reported."],
					session,
				),
			);
		}
		if ((session.contextPercent ?? 0) >= 85 && session.status.kind === "needs-you") {
			cards.push(
				card(
					"warning",
					`${label} is near the context limit`,
					"Compact while idle before sending more work so the next turn has room.",
					[`Context is ${Math.round(session.contextPercent ?? 0)}% full.`, "Session is idle and waiting on you."],
					session,
					{ kind: "compact", pid: session.pid },
				),
			);
		}
		if (session.status.kind === "needs-you" && session.suggestion) {
			cards.push(
				card(
					"suggestion",
					`${label} has a next prompt ready`,
					"Send the existing prompt suggestion if it still matches your intent.",
					[`Suggestion: ${session.suggestion}`, statusAge ? `Waiting for ${statusAge}.` : "Waiting on the operator."],
					session,
					{ kind: "prompt", pid: session.pid, text: session.suggestion },
				),
			);
		}
		if ((session.contextPercent ?? 0) >= 92 && session.status.kind === "working") {
			cards.push(
				card(
					"info",
					`${label} is working with very high context`,
					"Let the current turn settle, then compact before further follow-up unless the session finishes soon.",
					[`Context is ${Math.round(session.contextPercent ?? 0)}% full.`, session.activity?.tool ? `Current tool: ${session.activity.tool}.` : `Activity: ${session.activity?.kind ?? "model"}.`],
					session,
				),
			);
		}
	}
	if (!cards.length) {
		cards.push(
			card(
				"info",
				"No urgent Hermes action",
				"No session is stalled, errored, rate-limited, or waiting with high context. Keep monitoring from the dashboard.",
				[`${snapshot.totals.sessions} session${snapshot.totals.sessions === 1 ? "" : "s"} in the snapshot.`],
			),
		);
	}
	return cards.slice(0, DEFAULT_MAX_CARDS);
}

function knownSession(snapshot: HermesSnapshot, pid: unknown): HermesSessionSnapshot | undefined {
	return typeof pid === "number" ? snapshot.sessions.find((session) => session.pid === pid) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function actionFrom(value: unknown, snapshot: HermesSnapshot): HermesCardAction | undefined {
	const input = asRecord(value);
	if (!input || typeof input.kind !== "string") return undefined;
	switch (input.kind) {
		case "ask": {
			const session = knownSession(snapshot, input.pid);
			return session && typeof input.question === "string" && input.question.trim() ? { kind: "ask", pid: session.pid, question: clip(input.question, 1000) } : undefined;
		}
		case "prompt": {
			const session = knownSession(snapshot, input.pid);
			const deliverAs = input.deliverAs === "steer" || input.deliverAs === "followUp" ? input.deliverAs : undefined;
			return session && typeof input.text === "string" && input.text.trim() ? { kind: "prompt", pid: session.pid, text: clip(input.text, 2000), deliverAs } : undefined;
		}
		case "compact": {
			const session = knownSession(snapshot, input.pid);
			return session ? { kind: "compact", pid: session.pid } : undefined;
		}
		case "notify":
			return typeof input.message === "string" && input.message.trim() ? { kind: "notify", message: clip(input.message, 1000) } : undefined;
		case "memory_proposal":
			return typeof input.text === "string" && input.text.trim() ? { kind: "memory_proposal", text: clip(input.text, 2000) } : undefined;
		case "skill_proposal":
			return typeof input.title === "string" && typeof input.body === "string" && input.title.trim() && input.body.trim() ? { kind: "skill_proposal", title: clip(input.title, 160), body: clip(input.body, 3000) } : undefined;
		default:
			return undefined;
	}
}

function severityFrom(value: unknown): HermesAdviceSeverity {
	return value === "critical" || value === "warning" || value === "suggestion" || value === "info" ? value : "suggestion";
}

function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
	const candidate = fenced?.[1] ?? text;
	const starts = [candidate.indexOf("{"), candidate.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
	for (const start of starts) {
		for (let end = candidate.length; end > start; end--) {
			try {
				return JSON.parse(candidate.slice(start, end));
			} catch {}
		}
	}
	throw new Error("Hermes did not return JSON");
}

export function normalizeHermesCards(raw: unknown, snapshot: HermesSnapshot, maxCards = DEFAULT_MAX_CARDS): HermesAdviceCard[] {
	const root = asRecord(raw);
	const items = Array.isArray(raw) ? raw : Array.isArray(root?.cards) ? root.cards : [];
	const cards: HermesAdviceCard[] = [];
	for (const item of items) {
		const input = asRecord(item);
		if (!input || typeof input.title !== "string" || typeof input.body !== "string") continue;
		const action = actionFrom(input.action, snapshot);
		const target = knownSession(snapshot, input.targetPid) ?? (action && "pid" in action ? knownSession(snapshot, action.pid) : undefined);
		const evidence = Array.isArray(input.evidence) ? input.evidence.filter((value): value is string => typeof value === "string") : [];
		cards.push({
			id: typeof input.id === "string" && input.id.trim() ? `hermes_${clip(input.id, 80).replace(/[^A-Za-z0-9_-]+/g, "_")}` : hashId("hermes", [input.title, input.body, action]),
			severity: severityFrom(input.severity),
			title: clip(input.title, 120),
			body: clip(input.body),
			evidence: evidence.map((entry) => clip(entry, EVIDENCE_LIMIT)).slice(0, 4),
			source: "hermes",
			targetPid: target?.pid,
			targetLabel: target?.label,
			action,
		});
	}
	return cards.slice(0, maxCards);
}

function promptFor(snapshot: HermesSnapshot, localCards: HermesAdviceCard[], feedbackSummary: readonly string[]): string {
	return `You are Hermes advising pi-dash, a terminal dashboard that manages running pi coding-agent sessions.\n\nReturn ONLY JSON matching this schema:\n{\"cards\":[{\"id\":\"short-stable-id\",\"severity\":\"info|suggestion|warning|critical\",\"title\":\"<=80 chars\",\"body\":\"<=500 chars\",\"targetPid\":123,\"evidence\":[\"short evidence\"],\"action\":{\"kind\":\"ask|prompt|compact|notify|memory_proposal|skill_proposal\", ...}}]}\n\nAllowed actions:\n- ask: {\"kind\":\"ask\",\"pid\":number,\"question\":string}\n- prompt: {\"kind\":\"prompt\",\"pid\":number,\"text\":string,\"deliverAs\":\"steer\"|\"followUp\" optional}\n- compact: {\"kind\":\"compact\",\"pid\":number}\n- notify: {\"kind\":\"notify\",\"message\":string}\n- memory_proposal: {\"kind\":\"memory_proposal\",\"text\":string}\n- skill_proposal: {\"kind\":\"skill_proposal\",\"title\":string,\"body\":string}\n\nRules:\n- Use only pids present in the snapshot.\n- Do not request transcript or tool-output access.\n- Prefer one clear next action over many speculative cards.\n- Mutating actions will be human-confirmed by pi-dash; still keep them conservative.\n- If repeated feedback suggests a durable preference, propose memory_proposal rather than claiming you wrote memory.\n\nRecent local feedback summary:\n${feedbackSummary.length ? feedbackSummary.map((line) => `- ${line}`).join("\n") : "- none yet"}\n\nDeterministic local cards pi-dash can already produce:\n${JSON.stringify(localCards, null, 2)}\n\nRedacted dashboard snapshot:\n${JSON.stringify(snapshot, null, 2)}\n`;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Hermes timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > 256_000) stdout = stdout.slice(-256_000);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(clip(stderr || `Hermes exited with ${signal ?? code}`)));
		});
	});
}

export class HermesAdvisor implements HermesAdvisorClient {
	private readonly ledgerPath: string;
	private readonly command: string | undefined;
	private readonly timeoutMs: number;
	private readonly maxCards: number;

	constructor(options: HermesAdvisorOptions) {
		this.ledgerPath = options.ledgerPath;
		this.command = options.command ?? process.env.PI_DASH_HERMES_BIN ?? "hermes";
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxCards = options.maxCards ?? DEFAULT_MAX_CARDS;
	}

	async review(snapshot: HermesSnapshot): Promise<HermesAdviceReview> {
		const feedbackSummary = await this.feedbackSummary();
		const localCards = deriveLocalCards(snapshot).slice(0, this.maxCards);
		if (!this.command) return { generatedAt: Date.now(), snapshotAt: snapshot.generatedAt, source: "local", cards: localCards, feedbackSummary };
		try {
			const output = await runCommand(this.command, ["-z", promptFor(snapshot, localCards, feedbackSummary)], this.timeoutMs);
			const hermesCards = normalizeHermesCards(extractJson(output), snapshot, this.maxCards);
			if (hermesCards.length) return { generatedAt: Date.now(), snapshotAt: snapshot.generatedAt, source: "hermes", cards: hermesCards, feedbackSummary };
			return { generatedAt: Date.now(), snapshotAt: snapshot.generatedAt, source: "local", cards: localCards, feedbackSummary, error: "Hermes returned no valid cards" };
		} catch (error) {
			return { generatedAt: Date.now(), snapshotAt: snapshot.generatedAt, source: "local", cards: localCards, feedbackSummary, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async recordFeedback(event: HermesFeedbackEvent): Promise<void> {
		const record = { ...event, at: event.at ?? new Date().toISOString() };
		await mkdir(dirname(this.ledgerPath), { recursive: true });
		await appendFile(this.ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
	}

	private async feedbackSummary(): Promise<string[]> {
		let text: string;
		try {
			text = await readFile(this.ledgerPath, "utf8");
		} catch {
			return [];
		}
		const events = text
			.split("\n")
			.filter(Boolean)
			.slice(-SUMMARY_EVENTS)
			.flatMap((line): HermesFeedbackEvent[] => {
				try {
					return [JSON.parse(line) as HermesFeedbackEvent];
				} catch {
					return [];
				}
			});
		const counts = new Map<string, number>();
		for (const event of events) {
			const key = `${event.kind} ${event.actionKind ?? "note"}: ${event.cardTitle}${event.targetLabel ? ` (${event.targetLabel})` : ""}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 12)
			.map(([key, count]) => (count > 1 ? `${key} ×${count}` : key));
	}
}

export function feedbackFor(card: HermesAdviceCard, kind: HermesFeedbackKind, detail?: string): HermesFeedbackEvent {
	return {
		kind,
		cardId: card.id,
		cardTitle: card.title,
		source: card.source,
		actionKind: actionKind(card.action),
		targetPid: card.targetPid,
		targetLabel: card.targetLabel,
		detail,
	};
}
