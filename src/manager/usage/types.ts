export interface UsageBucket {
	tokens: number;
	cost: number;
	cacheRead: number;
	prompt: number;
}

/** Hourly usage of one session (or subagent session) file. */
export interface FileUsage {
	path: string;
	/** The remote host (hosts.json name) whose file this is; unset for this machine's. Paths only identify a file within their host. */
	host?: string;
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
	/** Latest measured request context from the newest assistant usage; retained per file, not per hour. */
	context?: { tokens: number; at: number; model: string; peak: number; requests: number };
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

/** A change to a remote host's usage index, as its relay sends it. */
export interface UsageDelta {
	/** The first message of a relay process: it replaces whatever an earlier link delivered. */
	reset: boolean;
	changed: FileUsage[];
	removed: string[];
	/** True when this delta concludes a scan. */
	scanned: boolean;
}
