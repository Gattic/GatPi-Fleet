// Side questions: builds the request that asks a session's model about the session, from the
// same context its own requests carry, plus what is in flight right now.
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionContext } from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionContext["messages"][number];

/** How much of a running tool's output, and of the reply being written, an ask sees. */
export const LIVE_TAIL = 2000;
const ARGS_LIMIT = 200;

interface RunningTool {
	id: string;
	name: string;
	startedAt: number;
	/** Latest output snapshot the tool reported, if any. */
	output: string;
}

export interface LiveState {
	phase: "working" | "idle";
	phaseSince: number;
	/** The assistant message being streamed; it is not in the transcript until it ends. */
	partial?: AssistantMessage;
	running: readonly RunningTool[];
}

interface AskInput {
	/** The session's prompt and tools, sent beside a transcript that does not declare them. */
	systemPrompt: string;
	tools: Tool[];
	/** The session's context messages (compaction-aware), as the agent holds them. */
	messages: AgentMessage[];
	live: LiveState;
	question: string;
	now: number;
}

export const ASK_PREAMBLE =
	"[Side question from the user, asked from pi-dash, a dashboard watching this session. Answer it from what you know of this session. Do not call tools and do not continue the task. Neither this question nor your answer is added to the session.]";

function tail(text: string, limit: number): string {
	return text.length > limit ? `…${text.slice(-(limit - 1))}` : text;
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The text blocks of message content, joined. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * A running tool has no result yet. pi-ai would answer its call with "No result provided" (an
 * error), so it gets a result that says it is still running, after the results already in.
 */
function withRunningResults(messages: Message[], running: readonly RunningTool[], now: number): Message[] {
	const result = [...messages];
	for (const tool of running) {
		const callIndex = result.findLastIndex((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === tool.id));
		if (callIndex === -1) continue;
		let insertAt = callIndex + 1;
		while (insertAt < result.length && result[insertAt].role === "toolResult") insertAt++;
		const output = tool.output.trim() ? `Output so far:\n${tail(tool.output, LIVE_TAIL)}` : "No output yet.";
		const stillRunning: ToolResultMessage = {
			role: "toolResult",
			toolCallId: tool.id,
			toolName: tool.name,
			content: [{ type: "text", text: `Still running (started ${duration(now - tool.startedAt)} ago). ${output}` }],
			isError: false,
			timestamp: now,
		};
		result.splice(insertAt, 0, stillRunning);
	}
	return result;
}

function statusBlock(live: LiveState, now: number): string {
	const lines =
		live.phase === "working"
			? [`Session status: working for ${duration(now - live.phaseSince)}.`]
			: [`Session status: idle for ${duration(now - live.phaseSince)}, waiting for the user.`];
	if (live.running.length) {
		const tools = live.running.map((tool) => `${tool.name} (started ${duration(now - tool.startedAt)} ago)`).join(", ");
		lines.push(`Tools still running: ${tools}. Their output so far is in their tool results above.`);
	}
	const partial = live.partial;
	if (partial) {
		const thinking = partial.content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking)
			.join("\n")
			.trim();
		const text = textOf(partial.content).trim();
		const calls = partial.content.filter((block) => block.type === "toolCall");
		lines.push("", "Your reply in progress (not in the transcript yet):");
		if (thinking) lines.push(`Thinking so far:\n${tail(thinking, LIVE_TAIL)}`);
		if (text) lines.push(`Text so far:\n${tail(text, LIVE_TAIL)}`);
		for (const call of calls) lines.push(`Preparing tool call: ${call.name} ${clip(JSON.stringify(call.arguments ?? {}), ARGS_LIMIT)}`);
		if (!thinking && !text && !calls.length) lines.push("(nothing streamed yet)");
	}
	return lines.join("\n");
}

/** The ask request: the session's own system prompt, tools and context, then the question. */
export function buildAskContext(input: AskInput): Context {
	const { live, now } = input;
	const messages = withRunningResults(convertToLlm(input.messages), live.running, now);
	const text = [ASK_PREAMBLE, statusBlock(live, now), `Question: ${input.question}`].join("\n\n");
	messages.push({ role: "user", content: [{ type: "text", text }], timestamp: now });
	// pi 1.x records the prompt and tools in the transcript as system messages; pi 0.84 sends them beside it.
	if (messages.some((message) => message.role === "system")) return { messages };
	return { systemPrompt: input.systemPrompt, messages, tools: input.tools };
}

/** Anthropic content blocks that can carry a cache breakpoint (thinking blocks cannot). */
const CACHEABLE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result"]);

/**
 * Anthropic caches a prompt up to the blocks a request marks, and pi marks the request's last block:
 * for an ask, the question. Moving that mark to the end of the session's context caches what the
 * next ask, and the session's own next request, share. Without it, asks after the session's cache
 * expired reuse only the system prompt and tools (measured: 21% instead of 99%). The number of marks
 * stays the same; payloads without Anthropic marks are left alone.
 */
export function cacheBeforeQuestion(payload: unknown): unknown {
	const messages = (payload as { messages?: unknown } | undefined)?.messages;
	if (!Array.isArray(messages) || messages.length < 2) return payload;
	const question: unknown = messages[messages.length - 1]?.content;
	const marked = Array.isArray(question) ? question.at(-1) : undefined;
	if (!marked?.cache_control) return payload;
	const previous = messages[messages.length - 2];
	if (typeof previous?.content === "string") previous.content = [{ type: "text", text: previous.content }];
	const target = Array.isArray(previous?.content) ? previous.content.at(-1) : undefined;
	if (!target || !CACHEABLE_BLOCKS.has(target.type)) return payload;
	target.cache_control = marked.cache_control;
	delete marked.cache_control;
	return payload;
}

/** The answer in a finished ask response, or why there is none. */
export function answerOf(message: AssistantMessage): { answer: string } | { error: string } {
	if (message.stopReason === "aborted") return { error: "aborted" };
	if (message.stopReason === "error") return { error: message.errorMessage ?? "provider error" };
	const answer = textOf(message.content).trim();
	if (answer) return { answer };
	const call = message.content.find((block) => block.type === "toolCall");
	return { error: call ? `tried to call ${call.name} instead of answering` : "the model gave no answer" };
}
