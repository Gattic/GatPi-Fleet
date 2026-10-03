export interface UsageBucket {
	tokens: number;
	cost: number;
	cacheRead: number;
	prompt: number;
}

/** Hourly usage of one session (or subagent session) file. */
export interface FileUsage {
	path: string;
	kind: "session" | "subagent";
	cwd?: string;
	sessionId?: string;
	/** For subagent files: the pi session that spawned the subagent. */
	parentSessionId?: string;
	name?: string;
	firstPrompt?: string;
	size: number;
	mtimeMs: number;
	/** Bytes indexed so far (always at a line boundary). */
	offset: number;
	/** hour (epoch ms / 3.6e6) → model key → usage. */
	hours: Record<string, Record<string, UsageBucket>>;
}

export interface ScanRequest {
	type: "scan";
	sessionRoot: string;
	/** Project directories whose `.pi/subagents/rpc-sessions` should be indexed. */
	subagentCwds: string[];
	retentionMs: number;
}

export interface IndexUpdate {
	type: "update";
	changed: FileUsage[];
	removed: string[];
	/** True when this update concludes a scan. */
	scanned: boolean;
	durationMs: number;
}
