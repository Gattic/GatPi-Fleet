// Byte-level extraction of usage records from pi session JSONL. Session files
// reach hundreds of MB, mostly tool output, so only small slices are decoded.
import { type PiUsage, usageTokens } from "../../protocol/index.ts";

export interface UsageRecord {
	ts: number;
	/** "provider/model", or "(summary)" / "(tool)" for nested and summary usage. */
	model: string;
	tokens: number;
	cost: number;
	cacheRead: number;
	/** Prompt-side tokens (input + cacheRead + cacheWrite), for cache hit ratio. */
	prompt: number;
}

export interface FileMeta {
	sessionId?: string;
	cwd?: string;
	name?: string;
	firstPrompt?: string;
}

const HEAD_BYTES = 512;
const NEWLINE = 0x0a;
const PREFIX_HEADER = Buffer.from('{"type":"session","');
const PREFIX_INFO = Buffer.from('{"type":"session_info"');
const PREFIX_MESSAGE = Buffer.from('{"type":"message"');
const PREFIX_COMPACTION = Buffer.from('{"type":"compaction"');
const PREFIX_BRANCH_SUMMARY = Buffer.from('{"type":"branch_summary"');
const ROLE_ASSISTANT = Buffer.from('"message":{"role":"assistant"');
const ROLE_TOOL_RESULT = Buffer.from('"message":{"role":"toolResult"');
const ROLE_USER = Buffer.from('"message":{"role":"user"');
const KEY_USAGE = Buffer.from('"usage":{');
const KEY_TIMESTAMP = Buffer.from('"timestamp":"');
const KEY_MODEL = Buffer.from('"model":"');
const KEY_PROVIDER = Buffer.from('"provider":"');

function startsWith(line: Buffer, prefix: Buffer): boolean {
	return line.length >= prefix.length && line.compare(prefix, 0, prefix.length, 0, prefix.length) === 0;
}

function stringAfter(line: Buffer, keyIndex: number, key: Buffer): string | undefined {
	if (keyIndex < 0) return undefined;
	const start = keyIndex + key.length;
	const end = line.indexOf(0x22, start);
	return end < 0 ? undefined : line.toString("utf8", start, end);
}

/** Parse the balanced `{...}` object starting at `open` (usage objects contain no strings). */
function objectAt(line: Buffer, open: number): unknown {
	let depth = 0;
	for (let index = open; index < line.length; index++) {
		const byte = line[index];
		if (byte === 0x7b) depth++;
		else if (byte === 0x7d && --depth === 0) return JSON.parse(line.toString("utf8", open, index + 1));
	}
	return undefined;
}

function record(ts: number, model: string, usage: PiUsage | undefined): UsageRecord | undefined {
	if (!usage || !Number.isFinite(ts)) return undefined;
	return {
		ts,
		model,
		tokens: usageTokens(usage),
		cost: usage.cost?.total ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		prompt: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join(" ");
}

/** Extract usage and metadata from one JSONL line (without its newline). */
export function scanLine(line: Buffer, meta: FileMeta, out: UsageRecord[]): void {
	if (startsWith(line, PREFIX_MESSAGE)) {
		const head = line.subarray(0, HEAD_BYTES);
		const ts = Date.parse(stringAfter(line, head.indexOf(KEY_TIMESTAMP), KEY_TIMESTAMP) ?? "");
		if (head.indexOf(ROLE_ASSISTANT) >= 0) {
			// The message's own usage follows its content (which may contain tool arguments).
			const usageIndex = line.lastIndexOf(KEY_USAGE);
			if (usageIndex < 0) return;
			const before = line.subarray(0, usageIndex);
			const provider = stringAfter(line, before.lastIndexOf(KEY_PROVIDER), KEY_PROVIDER) ?? "unknown";
			const model = stringAfter(line, before.lastIndexOf(KEY_MODEL), KEY_MODEL) ?? "unknown";
			const entry = record(ts, `${provider}/${model}`, objectAt(line, usageIndex + KEY_USAGE.length - 1) as PiUsage);
			if (entry) out.push(entry);
		} else if (head.indexOf(ROLE_TOOL_RESULT) >= 0) {
			// Nested LLM usage is rare; tool details may contain unrelated "usage" keys, so parse fully.
			if (line.indexOf(KEY_USAGE) < 0) return;
			const message = JSON.parse(line.toString("utf8")).message as { usage?: PiUsage };
			const entry = record(ts, "(tool)", message.usage);
			if (entry) out.push(entry);
		} else if (meta.firstPrompt === undefined && head.indexOf(ROLE_USER) >= 0) {
			const text = textOf((JSON.parse(line.toString("utf8")).message as { content: unknown }).content).replace(/\s+/g, " ").trim();
			if (text) meta.firstPrompt = text.slice(0, 200);
		}
	} else if (startsWith(line, PREFIX_COMPACTION) || startsWith(line, PREFIX_BRANCH_SUMMARY)) {
		const entry = JSON.parse(line.toString("utf8")) as { timestamp: string; usage?: PiUsage };
		const usage = record(Date.parse(entry.timestamp), "(summary)", entry.usage);
		if (usage) out.push(usage);
	} else if (startsWith(line, PREFIX_INFO)) {
		const name = (JSON.parse(line.toString("utf8")) as { name?: string }).name?.trim();
		meta.name = name || undefined;
	} else if (startsWith(line, PREFIX_HEADER)) {
		const header = JSON.parse(line.toString("utf8")) as { id?: string; cwd?: string };
		meta.sessionId = header.id;
		meta.cwd = header.cwd;
	}
}

/** Scan complete lines in `data`; returns bytes consumed (through the last newline). */
export function scanBuffer(data: Buffer, meta: FileMeta, out: UsageRecord[]): number {
	let start = 0;
	let newline = data.indexOf(NEWLINE, start);
	while (newline >= 0) {
		if (newline > start) {
			try {
				scanLine(data.subarray(start, newline), meta, out);
			} catch {
				// A corrupt line must not stop indexing the rest of the file.
			}
		}
		start = newline + 1;
		newline = data.indexOf(NEWLINE, start);
	}
	return start;
}
