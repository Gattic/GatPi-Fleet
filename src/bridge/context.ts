// Composition of a session's model context. The total stays pi's measurement;
// every part is pi's own chars/4 estimate, so the residual is shown, never hidden.
import { calculateContextTokens, DEFAULT_COMPACTION_SETTINGS, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextBreakdown, ContextParts } from "../protocol/index.ts";

/**
 * pi's estimator shape. `AgentMessage` lives in pi-agent-core, which is nested inside
 * pi-coding-agent and not a direct dependency here, so derive it from the function.
 */
type AgentMessage = Parameters<typeof estimateTokens>[0];
export type SystemMessage = Extract<AgentMessage, { role: "system" }>;

/** Matches pi's ESTIMATED_IMAGE_CHARS in core/compaction/compaction.ts; pinned by a test. */
const IMAGE_CHARS = 4800;
/** How many past requests the context series keeps. */
export const HISTORY_LIMIT = 32;

export interface BreakdownInput {
	/** The request's leading system message (prompt plus tool declarations), when captured. */
	system?: SystemMessage;
	/** The conversation projection: everything the next request carries besides the system message. */
	messages: readonly AgentMessage[];
	/** pi's measurement for the active model, when it has a context window. */
	usage?: { tokens: number | null; window: number; percent: number | null };
	/** From `pi.getSettings().compaction`. */
	compaction?: { enabled?: boolean; reserveTokens?: number };
	/** Context tokens of past requests, oldest first. */
	history?: readonly number[];
	now: number;
}

/** Context tokens of each assistant response, oldest first, bounded to HISTORY_LIMIT. */
export function contextHistory(entries: readonly SessionEntry[]): number[] {
	const history: number[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const tokens = calculateContextTokens(entry.message.usage);
		if (tokens > 0) history.push(tokens);
	}
	return history.slice(-HISTORY_LIMIT);
}

/** Split the system message into its prompt text and its tool declarations, both estimated. */
function systemParts(system: SystemMessage): [number, number] {
	const combined = estimateTokens(system);
	const text = estimateTokens({ ...system, toolsAdded: undefined });
	return [text, Math.max(0, combined - text)];
}

function imageBlocksOf(message: AgentMessage): number {
	const content: unknown = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	let blocks = 0;
	for (const block of content) if ((block as { type?: unknown })?.type === "image") blocks++;
	return blocks;
}

export function computeContextBreakdown(input: BreakdownInput): ContextBreakdown {
	const parts: ContextParts = { system: 0, tools: 0, injected: 0, user: 0, assistant: 0, toolResults: 0, summary: 0 };
	const counts = { user: 0, assistant: 0, toolResults: 0, injected: 0, imageBlocks: 0 };
	let imageTokens = 0;

	if (input.system) {
		const [text, tools] = systemParts(input.system);
		parts.system = text;
		parts.tools = tools;
	}

	for (const message of input.messages) {
		const tokens = estimateTokens(message);
		switch (message.role) {
			case "system":
				parts.system += tokens;
				break;
			case "custom":
				parts.injected += tokens;
				counts.injected++;
				break;
			case "user":
				parts.user += tokens;
				counts.user++;
				break;
			case "assistant":
				parts.assistant += tokens;
				counts.assistant++;
				break;
			case "toolResult":
			case "bashExecution":
				parts.toolResults += tokens;
				counts.toolResults++;
				break;
			case "branchSummary":
			case "compactionSummary":
				parts.summary += tokens;
				break;
		}
		const blocks = imageBlocksOf(message);
		if (blocks) {
			counts.imageBlocks += blocks;
			imageTokens += Math.ceil((IMAGE_CHARS * blocks) / 4);
		}
	}

	const measured = input.usage?.tokens ?? null;
	const total = parts.system + parts.tools + parts.injected + parts.user + parts.assistant + parts.toolResults + parts.summary;
	const enabled = input.compaction?.enabled !== false;
	const reserve = input.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	return {
		parts,
		unattributed: measured === null ? null : measured - total,
		totalBasis: measured === null ? "estimate" : "measured",
		imageTokens,
		counts,
		compactAt: input.usage && enabled ? Math.max(0, input.usage.window - reserve) : null,
		history: [...(input.history ?? [])].slice(-HISTORY_LIMIT),
		at: input.now,
	};
}
