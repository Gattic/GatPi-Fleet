// Wire protocol between pi-dash and pi-dash-relay on a remote host: LF-delimited JSON over the
// stdin/stdout of the ssh session that runs the relay. The relay forwards that host's bridges
// (states as snapshots and patches) and answers requests.
import type { GitService } from "../manager/actions/git.ts";
import type { RecoveryRecord } from "../manager/recovery.ts";
import type { LaunchOptions } from "../manager/actions/launch.ts";
import type { Project, SessionSummary } from "../manager/actions/sessions.ts";
import type { HostSample, PiProcess, ResourceSample, SampleTarget } from "../manager/collectors/procs.ts";
import type { FileUsage, UsageDelta } from "../manager/usage/types.ts";
import type { Command, SessionIdentity, SessionPatch, SessionState } from "../protocol/index.ts";

/** Bumped on any change to these messages; the bridge protocol version is checked separately. */
export const RELAY_VERSION = 5;

export interface GpuSummary {
	utilization: number;
	memUsed: number;
	memTotal: number;
}

/** A process sample of the relay's host. Resources are keyed like the targets they were asked for. */
export interface WireSample {
	resources: [string, ResourceSample][];
	piProcesses: PiProcess[];
	interrupted: RecoveryRecord[];
	host: HostSample;
	gpu?: GpuSummary;
}

export const GIT_METHODS = ["getSummary", "listBranches", "status", "pull", "push", "pushSetUpstream", "switchBranch"] as const satisfies readonly (keyof GitService)[];
export type GitMethod = (typeof GIT_METHODS)[number];

export interface RelayOps {
	/** Resolves once the bridge acknowledges, like BridgeHub.send. */
	command: { params: { target: SessionIdentity; command: Command }; result: null };
	sample: { params: { targets: SampleTarget[] }; result: WireSample };
	/** The screen capture requested by the previous peek of this session (null on the first), and a new request. */
	peek: { params: { pid: number; sty: string; window?: string }; result: string[] | null };
	projects: { params: { live: string[] }; result: Project[] };
	sessions: { params: { cwd: string }; result: SessionSummary[] };
	/** The new screen's name. A leading `~` in cwd is the relay host's home. */
	launch: { params: LaunchOptions; result: string };
	/** Revalidate the host's lifecycle record before launching or dismissing it. */
	recover: { params: { instanceId: string }; result: string };
	dismissRecovery: { params: { instanceId: string }; result: null };
	git: { params: { method: GitMethod; args: unknown[] }; result: unknown };
}

export type RelayOp = keyof RelayOps;

export type RelayRequest = { [K in RelayOp]: { type: "request"; id: number; op: K; params: RelayOps[K]["params"] } }[RelayOp];

export type RelayMessage =
	| { type: "hello"; version: number; bridge: number; hostname: string }
	| { type: "snapshot"; pid: number; state: SessionState }
	| { type: "patch"; pid: number; changes: SessionPatch }
	| { type: "bye"; pid: number; reason: string }
	| { type: "disconnect"; pid: number; alive: boolean }
	| { type: "incompatible"; pid: number; version: number }
	/** The host's usage index changes, pushed as its session files are indexed. */
	| ({ type: "usage" } & UsageDelta)
	| { type: "result"; id: number; ok: true; value: unknown }
	/** `uncertain`: the command may have run (UncertainCommandError). */
	| { type: "result"; id: number; ok: false; error: string; uncertain?: boolean };

export function encodeRelay(message: RelayMessage | RelayRequest): string {
	return `${JSON.stringify(message)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Splits files into messages of about `maxChars` (one larger file gets its own), so a first scan stays under the receiver's line limit. */
export function chunkUsage(files: readonly FileUsage[], maxChars: number): FileUsage[][] {
	const messages: FileUsage[][] = [[]];
	let chars = 0;
	for (const file of files) {
		const size = JSON.stringify(file).length;
		if (chars + size > maxChars && messages.at(-1)!.length) {
			messages.push([]);
			chars = 0;
		}
		messages.at(-1)!.push(file);
		chars += size;
	}
	return messages;
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

/** What aggregation reads of an indexed file. A malformed one must not throw while the dashboard draws, and an hour that is not a number would be counted in every range. */
function isFileUsage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.path !== "string" || (value.kind !== "session" && value.kind !== "subagent") || !isRecord(value.hours)) return false;
	if (![value.cwd, value.sessionId, value.parentSessionId, value.name, value.firstPrompt].every(optionalString)) return false;
	return Object.entries(value.hours).every(
		([hour, models]) => /^\d+$/.test(hour) && isRecord(models) && Object.values(models).every((bucket) => isRecord(bucket) && [bucket.tokens, bucket.cost, bucket.cacheRead, bucket.prompt].every((amount) => typeof amount === "number" && Number.isFinite(amount))),
	);
}

/**
 * A relay message whose envelope is well formed, else undefined. The state inside a snapshot or
 * patch is the relay's bridges' and is trusted like local bridges' (same code, same version, same
 * user); its identity is checked because commands are routed by it.
 */
export function parseRelayMessage(value: unknown): RelayMessage | undefined {
	if (!isRecord(value)) return undefined;
	const message = value as RelayMessage;
	switch (value.type) {
		case "hello":
			return typeof value.version === "number" && typeof value.bridge === "number" && typeof value.hostname === "string" ? message : undefined;
		case "snapshot": {
			const state = value.state;
			return isId(value.pid) && isRecord(state) && state.pid === value.pid && typeof state.sessionId === "string" && typeof state.instanceId === "string" ? message : undefined;
		}
		case "patch":
			return isId(value.pid) && isRecord(value.changes) && (value.changes.pid === undefined || value.changes.pid === value.pid) ? message : undefined;
		case "bye":
			return isId(value.pid) && typeof value.reason === "string" ? message : undefined;
		case "disconnect":
			return isId(value.pid) && typeof value.alive === "boolean" ? message : undefined;
		case "incompatible":
			return isId(value.pid) && typeof value.version === "number" ? message : undefined;
		case "usage":
			return typeof value.reset === "boolean" && typeof value.scanned === "boolean" && Array.isArray(value.removed) && value.removed.every((path) => typeof path === "string") && Array.isArray(value.changed) && value.changed.every(isFileUsage) ? message : undefined;
		case "result":
			if (!isId(value.id)) return undefined;
			if (value.ok === true) return message;
			return value.ok === false && typeof value.error === "string" && (value.uncertain === undefined || typeof value.uncertain === "boolean") ? message : undefined;
		default:
			return undefined;
	}
}
