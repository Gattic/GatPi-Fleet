// pi-dash bridge: runs inside every interactive pi session, publishes live
// session state over a unix socket and executes dashboard commands.
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Activity,
	addUsage,
	type BridgeMessage,
	type Command,
	emptyUsage,
	encodeMessage,
	LineDecoder,
	type PiUsage,
	type PlanSnapshot,
	PROMPT_SUGGESTION_CHANGED_EVENT,
	PROTOCOL_VERSION,
	ROADMAP_CHANGED_EVENT,
	type SessionPatch,
	type SessionState,
	socketDir,
	socketPath,
	type ToolRun,
	type UsageMinute,
	usageTokens,
} from "../protocol/index.ts";

const FLUSH_INTERVAL_MS = 250;
const HEARTBEAT_MS = 10_000;
const MAX_TOOL_RUNS = 20;
const USAGE_MINUTES = 120;
const TEXT_LIMIT = 200;
const DETAIL_LIMIT = 80;
const SAID_LIMIT = 32_000;
const SUGGESTION_LIMIT = 2000;

function clip(text: string, limit: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** Like clip, but keeps line breaks (Markdown). */
function bound(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** SAID text of an assistant message: none when it calls tools, since that text only narrates the work. */
function replyOf(content: unknown): string {
	if (Array.isArray(content) && content.some((block) => block?.type === "toolCall")) return "";
	return bound(textOf(content), SAID_LIMIT);
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

function initialState(pi: ExtensionAPI, ctx: ExtensionContext, published: Pick<SessionState, "plan" | "suggestion">): SessionState {
	const now = Date.now();
	const direct = emptyUsage();
	const indirect = emptyUsage();
	const usageMinutes: UsageMinute[] = [];
	let lastPrompt: string | undefined;
	let lastSaid: string | undefined;
	// Same accounting as pi's /session: assistant + summaries are direct,
	// toolResult usage is nested LLM work performed by tools.
	for (const entry of ctx.sessionManager.getEntries()) {
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
		} else if (message.role === "toolResult" && message.usage) {
			addUsage(indirect, message.usage);
			addMinute(usageMinutes, timestamp, message.usage, now);
		} else if (message.role === "user") {
			const prompt = textOf(message.content);
			if (prompt.trim()) lastPrompt = clip(prompt, TEXT_LIMIT);
		}
	}
	const context = ctx.getContextUsage();
	return {
		pid: process.pid,
		sty: process.env.STY,
		window: process.env.WINDOW,
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		name: pi.getSessionName(),
		model: modelName(ctx.model),
		thinking: ctx.thinkingLevel,
		phase: ctx.isIdle() ? "idle" : "working",
		phaseSince: now,
		lastEventAt: now,
		lastPrompt,
		lastSaid,
		context: context ? { tokens: context.tokens, window: context.contextWindow, percent: context.percent } : undefined,
		usage: { direct, indirect },
		usageMinutes,
		plan: published.plan,
		suggestion: published.suggestion,
		tools: [],
	};
}

export default function piDashBridge(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let state: SessionState | undefined;
	// The roadmap and prompt suggestions may publish before this extension's session_start runs.
	let plan: PlanSnapshot | undefined;
	let suggestion: string | undefined;
	let server: Server | undefined;
	let serverPath: string | undefined;
	const clients = new Set<Socket>();
	const pending = new Map<string, unknown>();
	let flushTimer: NodeJS.Timeout | undefined;
	const runningTools = new Map<string, ToolRun>();

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
		set({ context: usage ? { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent } : undefined });
	}

	function recordUsage(usage: PiUsage, kind: "direct" | "indirect", timestamp: number): void {
		if (!state) return;
		const totals = { ...state.usage, [kind]: { ...state.usage[kind] } };
		addUsage(totals[kind], usage);
		const minutes = state.usageMinutes.map((minute) => ({ ...minute }));
		addMinute(minutes, timestamp, usage, Date.now());
		set({ usage: totals, usageMinutes: minutes });
	}

	function setPhase(phase: SessionState["phase"]): void {
		if (state && state.phase !== phase) set({ phase, phaseSince: Date.now() });
	}

	function runCommand(command: Command): void {
		if (!ctx || !state) throw new Error("session is not ready");
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
			case "rename":
				pi.setSessionName(command.name.trim());
				return;
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
				const { id, command } = message as { id: number; command: Command };
				try {
					runCommand(command);
					socket.write(encodeMessage({ type: "ack", id, ok: true }));
				} catch (error) {
					socket.write(encodeMessage({ type: "ack", id, ok: false, error: error instanceof Error ? error.message : String(error) }));
				}
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
		state = undefined;
		ctx = undefined;
		runningTools.clear();
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
		state = initialState(pi, context, { plan, suggestion });
		startServer();
	});

	pi.on("session_shutdown", (event) => {
		if (state) stopServer(event.reason);
	});

	pi.on("session_info_changed", (event) => set({ name: event.name }));
	pi.on("model_select", (event) => set({ model: modelName(event.model) }));
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

	pi.on("tool_execution_end", (event) => {
		touch();
		if (!state) return;
		runningTools.delete(event.toolCallId);
		const endedAt = Date.now();
		set({ tools: state.tools.map((run) => (run.id === event.toolCallId ? { ...run, endedAt, isError: event.isError } : run)) });
		setActivity(currentToolActivity());
	});

	pi.on("message_end", (event) => {
		touch();
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
		setActivity(undefined);
		setPhase("idle");
		set({ lastSettledAt: Date.now() });
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
		if (ctx?.isIdle()) {
			setActivity(undefined);
			setPhase("idle");
		} else {
			setActivity(currentToolActivity());
		}
		refreshContext();
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
