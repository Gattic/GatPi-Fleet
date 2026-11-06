// pi-dash bridge: runs inside every interactive pi session, publishes live
// session state over a unix socket and executes dashboard commands.
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { sameSession, type ClientMessage } from "../protocol/index.ts";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Activity,
	type AskRun,
	addUsage,
	type BridgeMessage,
	type Command,
	emptyUsage,
	encodeMessage,
	LineDecoder,
	MAX_ASKS,
	MAX_PROMPTS,
	type PiUsage,
	type PlanSnapshot,
	PROMPT_SUGGESTION_CHANGED_EVENT,
	PROMPT_SUGGESTION_REQUEST_EVENT,
	PROTOCOL_VERSION,
	ROADMAP_CHANGED_EVENT,
	type SessionPatch,
	type SessionState,
	socketDir,
	socketPath,
	THINKING_LEVELS,
	TIMELINE_MS,
	type TimelineEntry,
	type TimelineState,
	type ToolRun,
	type UsageMinute,
	usageTokens,
} from "../protocol/index.ts";
import { answerOf, buildAskContext, cacheBeforeQuestion, textOf } from "./ask.ts";
import { computeContextBreakdown, contextHistory, type SystemMessage } from "./context.ts";
import { RecoveryJournal } from "../manager/recovery.ts";

const FLUSH_INTERVAL_MS = 250;
const HEARTBEAT_MS = 10_000;
const MAX_TOOL_RUNS = 20;
const USAGE_MINUTES = 120;
const TEXT_LIMIT = 200;
const DETAIL_LIMIT = 80;
const SAID_LIMIT = 32_000;
const SUGGESTION_LIMIT = 2000;
/** Characters of prompt history: a few pasted logs must not make every session update large. */
const PROMPTS_LIMIT = 100_000;

function clip(text: string, limit: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Like clip, but keeps line breaks (Markdown). */
function bound(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/** SAID text of an assistant message: none when it calls tools, since that text only narrates the work. */
function replyOf(content: unknown): string {
	if (Array.isArray(content) && content.some((block) => block?.type === "toolCall")) return "";
	return bound(textOf(content), SAID_LIMIT);
}

/**
 * `prompts` after `text` is sent: it becomes the newest, and an earlier copy is dropped. Then the newest
 * prompts that fit in MAX_PROMPTS and PROMPTS_LIMIT are kept whole, skipping any too long to fit.
 */
function remember(prompts: readonly string[], text: string): string[] {
	const prompt = text.trim();
	const all = [...prompts.filter((earlier) => earlier !== prompt), prompt];
	const kept: string[] = [];
	let chars = 0;
	for (let index = all.length - 1; index >= 0 && kept.length < MAX_PROMPTS; index--) {
		if (chars + all[index].length > PROMPTS_LIMIT) continue;
		chars += all[index].length;
		kept.unshift(all[index]);
	}
	return kept;
}

function toolDetail(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "file", "pattern", "query", "operation", "task"]) {
		if (typeof record[key] === "string" && record[key]) return clip(record[key] as string, DETAIL_LIMIT);
	}
	const firstString = Object.values(record).find((value) => typeof value === "string" && value);
	return typeof firstString === "string" ? clip(firstString, DETAIL_LIMIT) : "";
}

/**
 * The model's provider, called with the auth the registry resolves, as the registry itself does. The
 * provider applies its own request shaping (pi-multi-account's Claude OAuth shaping lives there).
 * pi 0.84's registry has no streamSimple. Its providers take a raw Context; pi 1.x providers take a
 * transcript that declares the prompt and tools, which buildAskContext sends unchanged.
 */
interface AskProvider {
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

function modelName(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function addMinute(minutes: UsageMinute[], timestamp: number, usage: PiUsage, now: number): void {
	const minute = Math.floor(timestamp / 60_000);
	const oldest = Math.floor(now / 60_000) - USAGE_MINUTES + 1;
	if (minute < oldest) return;
	let bucket = minutes.find((entry) => entry.minute === minute);
	if (!bucket) {
		bucket = { minute, tokens: 0, cost: 0 };
		minutes.push(bucket);
		minutes.sort((a, b) => a.minute - b.minute);
	}
	bucket.tokens += usageTokens(usage);
	bucket.cost += usage.cost?.total ?? 0;
	while (minutes.length && minutes[0].minute < oldest) minutes.shift();
}

/**
 * Records `state` from `at`. A change at the same moment as the latest entry replaces it, and an unchanged
 * state adds nothing. Entries older than the timeline reaches are dropped; the one in force at its start
 * is kept, moved to the start.
 */
function pushTimeline(timeline: readonly TimelineEntry[], at: number, state: TimelineState): TimelineEntry[] {
	const next = [...timeline];
	while (next.length && (next.at(-1) as TimelineEntry).at >= at) next.pop();
	if (next.at(-1)?.state !== state) next.push({ at, state });
	const start = at - TIMELINE_MS;
	let first = 0;
	while (first + 1 < next.length && next[first + 1].at <= start) first++;
	const kept = next.slice(first);
	if (kept[0].at < start) kept[0] = { at: start, state: kept[0].state };
	return kept;
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const all = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().flatMap((name) => {
		const tool = all.get(name);
		return tool ? [{ name, description: tool.description, parameters: tool.parameters }] : [];
	});
}

/** The request's leading system message, reconstructed until the first request captures the real one. */
function systemMessageOf(ctx: ExtensionContext, pi: ExtensionAPI): SystemMessage {
	return { role: "system", content: [{ type: "text", text: ctx.getSystemPrompt() }], toolsAdded: activeTools(pi), timestamp: Date.now() };
}

function initialState(pi: ExtensionAPI, ctx: ExtensionContext, published: Pick<SessionState, "plan" | "suggestion">, capturedSystem: SystemMessage | undefined): SessionState {
	const now = Date.now();
	const entries = ctx.sessionManager.getEntries();
	const idle = ctx.isIdle();
	const direct = emptyUsage();
	const indirect = emptyUsage();
	const usageMinutes: UsageMinute[] = [];
	let lastPrompt: string | undefined;
	let prompts: string[] = [];
	let lastSaid: string | undefined;
	const tools = new Map<string, ToolRun>();
	// Runs in the transcript: working from each user message to the last message before the next one.
	const runs: TimelineEntry[] = [];
	let lastMessageAt: number | undefined;
	// Same accounting as pi's /session: assistant + summaries are direct,
	// toolResult usage is nested LLM work performed by tools.
	for (const entry of entries) {
		const timestamp = Date.parse(entry.timestamp);
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addUsage(direct, entry.usage);
			addMinute(usageMinutes, timestamp, entry.usage, now);
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			addUsage(direct, message.usage);
			addMinute(usageMinutes, timestamp, message.usage, now);
			const said = replyOf(message.content);
			if (said) lastSaid = said;
			for (const block of message.content) {
				if (block.type === "toolCall") tools.set(block.id, { id: block.id, name: block.name, detail: toolDetail(block.arguments), startedAt: timestamp });
			}
		} else if (message.role === "toolResult") {
			if (message.usage) {
				addUsage(indirect, message.usage);
				addMinute(usageMinutes, timestamp, message.usage, now);
			}
			const run = tools.get(message.toolCallId);
			if (run) Object.assign(run, { endedAt: timestamp, isError: message.isError });
		} else if (message.role === "user") {
			const prompt = textOf(message.content);
			if (prompt.trim()) {
				lastPrompt = clip(prompt, TEXT_LIMIT);
				prompts = remember(prompts, prompt);
			}
			if (lastMessageAt !== undefined && runs.at(-1)?.state === "working") runs.push({ at: lastMessageAt, state: "waiting" });
			runs.push({ at: timestamp, state: "working" });
		}
		lastMessageAt = timestamp;
	}
	// Idle with a transcript means the last run is over and the user is up.
	const lastSettledAt = idle && lastMessageAt !== undefined ? lastMessageAt : undefined;
	if (lastSettledAt !== undefined) runs.push({ at: lastSettledAt, state: "waiting" });
	// Before this process the session was not open, so the timeline starts with the process.
	let timeline: TimelineEntry[] = [{ at: now - process.uptime() * 1000, state: "idle" }];
	for (const run of runs) timeline = pushTimeline(timeline, Math.max(run.at, timeline[0].at), run.state);
	timeline = pushTimeline(timeline, now, idle ? (lastSettledAt !== undefined ? "waiting" : "idle") : "working");
	// A call without a result did not finish (the process ended or the run was cut off).
	const recentTools = [...tools.values()].slice(-MAX_TOOL_RUNS).map((run) => (run.endedAt === undefined ? { ...run, endedAt: run.startedAt, isError: true } : run));
	const models = ctx.scopedModels.length ? ctx.scopedModels.map((scoped) => scoped.model) : ctx.modelRegistry.getAvailable();
	const context = ctx.getContextUsage();
	const breakdown = context
		? computeContextBreakdown({
			system: capturedSystem ?? systemMessageOf(ctx, pi),
			messages: buildSessionContext(entries, ctx.sessionManager.getLeafId()).messages,
			usage: { tokens: context.tokens, window: context.contextWindow, percent: context.percent },
			compaction: pi.getSettings().compaction,
			history: contextHistory(entries),
			now,
		})
		: undefined;
	return {
		pid: process.pid,
		instanceId: randomUUID(),
		sty: process.env.STY,
		window: process.env.WINDOW,
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		name: pi.getSessionName(),
		model: modelName(ctx.model),
		thinking: ctx.thinkingLevel,
		phase: idle ? "idle" : "working",
		phaseSince: now,
		lastSettledAt,
		lastEventAt: now,
		lastPrompt,
		prompts,
		lastSaid,
		context: context ? { tokens: context.tokens, window: context.contextWindow, percent: context.percent, breakdown } : undefined,
		usage: { direct, indirect },
		usageMinutes,
		plan: published.plan,
		suggestion: published.suggestion,
		tools: recentTools,
		timeline,
		models: models.map((model) => `${model.provider}/${model.id}`),
		asks: [],
	};
}

// Unique per process, so an answer that outlives its session cannot land in the next one.
let askSeq = 0;

export default function piDashBridge(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let state: SessionState | undefined;
	/** The last request's leading system message: exact prompt and tool declarations. */
	let capturedSystem: SystemMessage | undefined;
	// Reload is command-context-only. Dispatch through a command, never through an agent prompt.
	pi.registerCommand("pi-dash-reload", {
		description: "Reload pi resources from pi-dash",
		handler: async (_args, commandCtx) => {
			if (!commandCtx.isIdle()) throw new Error("Reload only while idle");
			await commandCtx.reload();
		},
	});
	const recovery = new RecoveryJournal();
	let recoveryStartedAt = 0;
	let recoveryMetadata: string | undefined;

	function trackRecovery(): void {
		if (!state || !ctx) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile !== state.sessionFile) set({ sessionFile });
		const metadata = JSON.stringify([state.sessionFile, state.name]);
		if (metadata === recoveryMetadata) return;
		recovery.track(state, recoveryStartedAt);
		recoveryMetadata = metadata;
	}
	// The roadmap and prompt suggestions may publish before this extension's session_start runs.
	let plan: PlanSnapshot | undefined;
	let suggestion: string | undefined;
	let server: Server | undefined;
	let serverPath: string | undefined;
	const clients = new Set<Socket>();
	const pending = new Map<string, unknown>();
	let flushTimer: NodeJS.Timeout | undefined;
	const runningTools = new Map<string, ToolRun>();
	/** Latest output snapshot of each running tool that reports progress. */
	const toolOutput = new Map<string, string>();
	/** The assistant message being streamed. */
	let partial: AssistantMessage | undefined;
	let asking: AbortController | undefined;

	function broadcast(message: BridgeMessage): void {
		const line = encodeMessage(message);
		for (const socket of clients) socket.write(line);
	}

	function flush(): void {
		flushTimer = undefined;
		if (!pending.size) return;
		const changes = Object.fromEntries(pending) as SessionPatch;
		pending.clear();
		broadcast({ type: "patch", changes });
	}

	function set(changes: Partial<SessionState>): void {
		if (!state) return;
		const record = state as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries(changes)) {
			if (value === undefined) delete record[key];
			else record[key] = value;
			pending.set(key, value === undefined ? null : value);
		}
		if (clients.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
		if (!clients.size) pending.clear();
	}

	function touch(): void {
		if (!state) return;
		const now = Date.now();
		if (now - state.lastEventAt >= HEARTBEAT_MS) set({ lastEventAt: now });
	}

	function setActivity(activity: Omit<Activity, "since"> | undefined): void {
		if (!state) return;
		const current = state.activity;
		if (!activity) {
			if (current) set({ activity: undefined });
			return;
		}
		if (current && current.kind === activity.kind && current.tool === activity.tool && current.detail === activity.detail) return;
		set({ activity: { ...activity, since: Date.now() } });
	}

	function currentToolActivity(): Omit<Activity, "since"> {
		const latest = [...runningTools.values()].at(-1);
		return latest ? { kind: "tool", tool: latest.name, detail: latest.detail } : { kind: "model" };
	}

	function refreshContext(): void {
		if (!ctx || !state) return;
		const usage = ctx.getContextUsage();
		if (!usage) {
			set({ context: undefined });
			return;
		}
		const entries = ctx.sessionManager.getEntries();
		set({
			context: {
				tokens: usage.tokens,
				window: usage.contextWindow,
				percent: usage.percent,
				breakdown: computeContextBreakdown({
					system: capturedSystem ?? systemMessageOf(ctx, pi),
					messages: buildSessionContext(entries, ctx.sessionManager.getLeafId()).messages,
					usage: { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent },
					compaction: pi.getSettings().compaction,
					history: contextHistory(entries),
					now: Date.now(),
				}),
			},
		});
	}

	function recordUsage(usage: PiUsage, kind: "direct" | "indirect", timestamp: number): void {
		if (!state) return;
		const totals = { ...state.usage, [kind]: { ...state.usage[kind] } };
		addUsage(totals[kind], usage);
		const minutes = state.usageMinutes.map((minute) => ({ ...minute }));
		addMinute(minutes, timestamp, usage, Date.now());
		set({ usage: totals, usageMinutes: minutes });
	}

	/** Adds the current state to the timeline when it changed. */
	function recordTimeline(): void {
		if (!state) return;
		const current: TimelineState = state.phase === "working" ? "working" : state.lastSettledAt !== undefined ? "waiting" : "idle";
		if (state.timeline.at(-1)?.state !== current) set({ timeline: pushTimeline(state.timeline, Date.now(), current) });
	}

	/**
	 * pi reports a compaction (and its failure) while it is still compacting, and no event follows when it
	 * stops. A manual compaction leaves pi idle; look once pi has finished handling the current event.
	 */
	function settleAfterCompaction(): void {
		setTimeout(() => {
			if (!ctx?.isIdle()) return;
			setActivity(undefined);
			setPhase("idle");
			refreshContext();
		}, 0);
	}

	function setPhase(phase: SessionState["phase"]): void {
		if (state && state.phase !== phase) set({ phase, phaseSince: Date.now() });
		recordTimeline();
	}

	function updateAsk(id: number, changes: Partial<AskRun>): void {
		if (!state?.asks.some((run) => run.id === id)) return;
		set({ asks: state.asks.map((run) => (run.id === id ? { ...run, ...changes } : run)) });
	}

	/** The session's tools as its requests declare them: the active ones, in their order. */
	/**
	 * Asks the session's model about the session: its own system prompt, tools, context, model,
	 * thinking level and session id, so the request reuses the provider's cache of the session's
	 * prefix. Nothing is written to the session.
	 */
	async function startAsk(question: string): Promise<void> {
		if (!ctx || !state) throw new Error("session is not ready");
		const text = question.trim();
		if (!text) throw new Error("question is empty");
		if (asking) throw new Error("still answering the previous question");
		const model = ctx.model;
		if (!model) throw new Error("no model selected");
		const provider: AskProvider | undefined = ctx.modelRegistry.getProvider(model.provider);
		if (!provider) throw new Error(`unknown provider ${model.provider}`);
		const controller = new AbortController();
		asking = controller;
		let stream: AssistantMessageEventStream;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			if (controller.signal.aborted || !ctx || !state) throw new Error("session closed");
			const now = Date.now();
			const running = [...runningTools.values()].map((run) => ({ id: run.id, name: run.name, startedAt: run.startedAt, output: toolOutput.get(run.id) ?? "" }));
			const context = buildAskContext({
				systemPrompt: ctx.getSystemPrompt(),
				tools: activeTools(pi),
				messages: buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
				live: { phase: state.phase, phaseSince: state.phaseSince, partial, running },
				question: text,
				now,
			});
			const level = pi.getThinkingLevel();
			stream = provider.streamSimple(auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model, context, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				reasoning: level === "off" ? undefined : level,
				sessionId: ctx.sessionManager.getSessionId(),
				signal: controller.signal,
				onPayload: cacheBeforeQuestion,
			});
		} catch (error) {
			if (asking === controller) asking = undefined;
			throw error;
		}
		const run: AskRun = { id: ++askSeq, question: text, askedAt: Date.now(), status: "answering", answer: "" };
		set({ asks: [...state.asks, run].slice(-MAX_ASKS) });
		// The question reaches the dashboard before the ack does.
		if (flushTimer) clearTimeout(flushTimer);
		flush();
		void answer(run.id, stream, controller);
	}

	async function answer(id: number, stream: AssistantMessageEventStream, controller: AbortController): Promise<void> {
		try {
			for await (const event of stream) {
				if (event.type === "text_delta" || event.type === "text_end") updateAsk(id, { answer: bound(textOf(event.partial.content), SAID_LIMIT) });
			}
			const message = await stream.result();
			const usage = emptyUsage();
			addUsage(usage, message.usage);
			const result = answerOf(message);
			if ("answer" in result) updateAsk(id, { status: "answered", answer: bound(result.answer, SAID_LIMIT), usage });
			else updateAsk(id, { status: "failed", error: clip(result.error, TEXT_LIMIT), usage });
		} catch (error) {
			updateAsk(id, { status: "failed", error: clip(error instanceof Error ? error.message : String(error), TEXT_LIMIT) });
		} finally {
			if (asking === controller) asking = undefined;
		}
	}

	async function runCommand(command: Command, target: ClientMessage["target"]): Promise<void> {
		if (!ctx || !state) throw new Error("session is not ready");
		if (!target || !sameSession(state, target)) throw new Error("session changed; refresh before sending");
		switch (command.kind) {
			case "prompt": {
				const text = command.text.trim();
				if (!text) throw new Error("prompt is empty");
				if (ctx.isIdle()) pi.sendUserMessage(text);
				else pi.sendUserMessage(text, { deliverAs: command.deliverAs ?? "steer" });
				set({ lastPrompt: clip(text, TEXT_LIMIT) });
				return;
			}
			case "abort":
				ctx.abort();
				return;
			case "shutdown":
				ctx.shutdown();
				return;
			case "reload":
				if (!ctx.isIdle()) throw new Error("Reload only while idle");
				if (state.asks.some((ask) => ask.status === "answering")) throw new Error("A side question is still answering");
				// Let the ACK reach the controller before reload tears down this socket/runtime.
				setImmediate(() => {
					if (state && sameSession(state, target)) pi.sendUserMessage("/pi-dash-reload", { deliverAs: "followUp", expandPromptTemplates: true });
				});
				return;
			case "suggest": {
				if (!ctx.isIdle() || state.phase !== "idle") throw new Error("Request a prompt suggestion only while idle");
				let handled = false;
				let failure: string | null = null;
				pi.events.emit(PROMPT_SUGGESTION_REQUEST_EVENT, {
					respond: (error: string | null) => { handled = true; failure = error; },
				});
				if (!handled) throw new Error("prompt-suggestions request unavailable; update GatPi-Harness and reload this session");
				if (failure !== null) throw new Error(failure);
				return;
			}
			case "rename":
				pi.setSessionName(command.name.trim());
				return;
			case "compact":
				if (!ctx.isIdle()) throw new Error("session is working; compact when it is idle");
				ctx.compact({
					onError: (error) => {
						set({ lastError: { message: clip(`compaction failed: ${error.message}`, TEXT_LIMIT), at: Date.now() } });
						settleAfterCompaction();
					},
				});
				return;
			case "model": {
				const model = ctx.modelRegistry.find(command.provider, command.id);
				if (!model) throw new Error(`unknown model ${command.provider}/${command.id}`);
				if (!(await pi.setModel(model))) throw new Error(`no credentials for ${command.provider}`);
				return;
			}
			case "thinking":
				if (!THINKING_LEVELS.includes(command.level)) throw new Error(`unknown thinking level ${command.level}`);
				// pi clamps the level to the model; a change arrives as thinking_level_select.
				pi.setThinkingLevel(command.level);
				return;
			case "ask":
				await startAsk(command.question);
				return;
			default:
				throw new Error(`unknown command ${(command as { kind?: unknown }).kind}`);
		}
	}

	function onConnection(socket: Socket): void {
		socket.unref();
		socket.setEncoding("utf8");
		clients.add(socket);
		const decoder = new LineDecoder();
		socket.write(encodeMessage({ type: "hello", version: PROTOCOL_VERSION }));
		if (state) socket.write(encodeMessage({ type: "snapshot", state }));
		socket.on("data", (chunk: string) => {
			let messages: unknown[];
			try {
				messages = decoder.push(chunk);
			} catch {
				socket.destroy();
				return;
			}
			for (const message of messages) {
				if (!message || typeof message !== "object" || !("type" in message) || message.type !== "command" || !("id" in message) || !Number.isSafeInteger(message.id)) {
					socket.destroy();
					return;
				}
				const { id, command, target } = message as ClientMessage;
				runCommand(command, target).then(
					() => socket.write(encodeMessage({ type: "ack", id, ok: true })),
					(error: unknown) => socket.write(encodeMessage({ type: "ack", id, ok: false, error: error instanceof Error ? error.message : String(error) })),
				);
			}
		});
		socket.on("close", () => clients.delete(socket));
		socket.on("error", () => clients.delete(socket));
	}

	function startServer(): void {
		const dir = socketDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = socketPath(process.pid, dir);
		// A previous session instance in this process (or a crashed process with a reused pid) may have left it behind.
		try {
			unlinkSync(path);
		} catch {}
		const created = createServer(onConnection);
		created.on("error", () => {});
		created.listen(path, () => chmodSync(path, 0o600));
		created.unref();
		server = created;
		serverPath = path;
	}

	function stopServer(reason: string): void {
		if (flushTimer) clearTimeout(flushTimer);
		flush();
		broadcast({ type: "bye", reason });
		for (const socket of clients) socket.end();
		clients.clear();
		server?.close();
		if (serverPath) {
			try {
				unlinkSync(serverPath);
			} catch {}
		}
		server = undefined;
		serverPath = undefined;
		asking?.abort();
		asking = undefined;
		state = undefined;
		ctx = undefined;
		runningTools.clear();
		toolOutput.clear();
		partial = undefined;
	}

	pi.events.on(ROADMAP_CHANGED_EVENT, (data) => {
		plan = (data ?? undefined) as PlanSnapshot | undefined;
		set({ plan });
	});

	pi.events.on(PROMPT_SUGGESTION_CHANGED_EVENT, (data) => {
		suggestion = typeof data === "string" && data.trim() ? bound(data, SUGGESTION_LIMIT) : undefined;
		set({ suggestion });
	});

	pi.on("session_start", (_event, context) => {
		if (context.mode !== "tui") return;
		ctx = context;
		capturedSystem = undefined;
		state = initialState(pi, context, { plan, suggestion }, capturedSystem);
		recoveryStartedAt = Date.now();
		recoveryMetadata = undefined;
		startServer();
		trackRecovery();
	});

	pi.on("session_shutdown", (event) => {
		if (!state) return;
		// Reload closes the extension, not the conversation. Keep recovery until its replacement
		// records ownership, so a fatal error or OOM during reload cannot erase the current session.
		try { if (event.reason !== "reload") recovery.close(state.instanceId); }
		finally { stopServer(event.reason); }
	});

	pi.on("session_info_changed", (event) => {
		set({ name: event.name });
		trackRecovery();
	});
	// The request's leading system message carries the exact prompt and tool declarations;
	// capture it rather than rebuilding them, and keep the handler O(1) (it runs before each call).
	pi.on("context_with_system", (event) => {
		const leading = event.messages[0];
		capturedSystem = leading?.role === "system" ? leading : undefined;
	});

	pi.on("model_select", (event) => {
		// The next request replaces it; until then, rebuild from the new model's prompt and tools.
		capturedSystem = undefined;
		set({ model: modelName(event.model) });
		refreshContext();
	});
	pi.on("thinking_level_select", (event) => set({ thinking: event.level }));

	pi.on("input", (event) => {
		touch();
		if (event.text.trim()) set({ lastPrompt: clip(event.text, TEXT_LIMIT), lastError: undefined });
	});

	pi.on("agent_start", () => {
		touch();
		setPhase("working");
		setActivity(currentToolActivity());
	});

	pi.on("message_update", (event) => {
		touch();
		if (event.message.role === "assistant") partial = event.message;
		if (runningTools.size) return;
		const type = event.assistantMessageEvent.type;
		if (type.startsWith("thinking")) setActivity({ kind: "thinking" });
		else if (type.startsWith("text")) setActivity({ kind: "writing" });
	});

	pi.on("tool_execution_start", (event) => {
		touch();
		if (!state) return;
		const run: ToolRun = { id: event.toolCallId, name: event.toolName, detail: toolDetail(event.args), startedAt: Date.now() };
		runningTools.set(run.id, run);
		set({ tools: [...state.tools, run].slice(-MAX_TOOL_RUNS) });
		setActivity(currentToolActivity());
	});

	// Providers can report progress without emitting normalized text/thinking deltas.
	pi.on("provider_stream_event", () => touch());

	pi.on("tool_execution_update", (event) => {
		touch();
		const content: unknown = event.partialResult?.content;
		if (runningTools.has(event.toolCallId) && Array.isArray(content)) toolOutput.set(event.toolCallId, textOf(content));
	});

	pi.on("tool_execution_end", (event) => {
		touch();
		toolOutput.delete(event.toolCallId);
		if (!state) return;
		runningTools.delete(event.toolCallId);
		const endedAt = Date.now();
		set({ tools: state.tools.map((run) => (run.id === event.toolCallId ? { ...run, endedAt, isError: event.isError } : run)) });
		setActivity(currentToolActivity());
	});

	pi.on("message_end", (event) => {
		trackRecovery();
		touch();
		partial = undefined;
		const message = event.message;
		if (message.role === "assistant") {
			recordUsage(message.usage, "direct", message.timestamp);
			const said = replyOf(message.content);
			if (said) set({ lastSaid: said });
			// After a user abort pi can persist the interrupted turn as an error; that is not a failure.
			const aborted = message.stopReason === "aborted" || ctx?.signal?.aborted === true;
			if (message.stopReason === "error" && !aborted) {
				set({ lastError: { message: clip(message.errorMessage ?? "provider error", TEXT_LIMIT), at: Date.now() } });
			} else if (!aborted) {
				set({ lastError: undefined });
			}
		} else if (message.role === "toolResult" && message.usage) {
			recordUsage(message.usage, "indirect", message.timestamp);
		} else if (message.role === "user" && state) {
			// Prompts typed in pi, sent from the dashboard or the phone, steers and follow-ups alike.
			const prompt = textOf(message.content);
			if (prompt.trim()) set({ prompts: remember(state.prompts, prompt) });
		}
	});

	pi.on("turn_end", () => {
		touch();
		refreshContext();
	});

	pi.on("agent_end", () => {
		touch();
		setActivity({ kind: "continuing" });
	});

	pi.on("agent_settled", () => {
		touch();
		runningTools.clear();
		toolOutput.clear();
		partial = undefined;
		setActivity(undefined);
		set({ lastSettledAt: Date.now() });
		setPhase("idle");
		refreshContext();
	});

	pi.on("session_before_compact", () => {
		touch();
		setPhase("working");
		setActivity({ kind: "compacting" });
	});

	pi.on("session_compact", (event) => {
		touch();
		if (event.compactionEntry.usage) recordUsage(event.compactionEntry.usage, "direct", Date.now());
		// A finished compaction supersedes an earlier error (such as a failed compaction), which would otherwise show until the next reply.
		set({ lastError: undefined });
		setActivity(currentToolActivity());
		refreshContext();
		settleAfterCompaction();
	});

	pi.on("session_tree", (event) => {
		touch();
		if (event.summaryEntry?.usage) recordUsage(event.summaryEntry.usage, "direct", Date.now());
		refreshContext();
	});

	pi.on("after_provider_response", (event) => {
		touch();
		if (event.status === 429) set({ rateLimited: { at: Date.now(), retryAfter: event.headers["retry-after"] } });
		else if (event.status < 400 && state?.rateLimited) set({ rateLimited: undefined });
	});
}
