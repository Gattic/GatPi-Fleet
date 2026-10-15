// One remote host: pi-dash-relay runs there over ssh. Mirrors the states of the host's bridges,
// sends requests, and reconnects with backoff when the link drops or stops answering.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { applyPatch, type Command, LineDecoder, PROTOCOL_VERSION, sameSession, type SessionIdentity, type SessionState } from "../../protocol/index.ts";
import { encodeRelay, type GpuSummary, parseRelayMessage, RELAY_VERSION, type RelayMessage, type RelayOp, type RelayOps, type RelayRequest } from "../../relay/protocol.ts";
import { UncertainCommandError } from "../collectors/bridges.ts";
import type { HostSample, Sample, SampleTarget } from "../collectors/procs.ts";
import { relayCommand } from "./hosts.ts";
import type { RecoveryRecord } from "../recovery.ts";

export interface RemoteEvents {
	onState(pid: number, state: SessionState): void;
	onBye(pid: number, reason: string): void;
	onDisconnect(pid: number, alive: boolean): void;
	onIncompatible(pid: number, version: number): void;
	/** The link went down: the host's sessions are unknown until it is back. */
	onLost(): void;
}

export type HostStatus =
	| { kind: "connecting"; since: number }
	/** `hostname`: the remote machine's own name. */
	| { kind: "online"; since: number; hostname: string }
	| { kind: "offline"; since: number; error: string };

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	command: boolean;
}

/** The relay answers commands within the bridge's own timeout; this only catches a hung relay or link. */
const REQUEST_TIMEOUT_MS = 30_000;
/** ssh's connect timeout, a login shell and starting Node. */
const HELLO_TIMEOUT_MS = 30_000;
const RETRY_MS = { min: 5000, max: 60_000 };

/** Remote text without terminal control sequences: it is drawn in this terminal. Keeps tabs and newlines. */
function withoutControls(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Every string inside a message from the relay, without control sequences. */
function sanitize(value: unknown): unknown {
	if (typeof value === "string") return withoutControls(value);
	if (Array.isArray(value)) return value.map(sanitize);
	if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
	return value;
}

function lastLine(text: string): string | undefined {
	return withoutControls(text)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
}

export class RemoteHost {
	readonly name: string;
	interrupted: RecoveryRecord[] = [];
	status: HostStatus = { kind: "connecting", since: Date.now() };
	/** From the latest sample. */
	vitals?: { host: HostSample; gpu?: GpuSummary };
	private readonly events: RemoteEvents;
	private readonly command: readonly string[];
	private child?: ChildProcessWithoutNullStreams;
	private readonly states = new Map<number, SessionState>();
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private retryMs = RETRY_MS.min;
	private retryTimer?: NodeJS.Timeout;
	private helloTimer?: NodeJS.Timeout;
	private started = false;
	private closed = false;

	/** `command` starts the relay; by default over ssh to `name`. */
	constructor(name: string, events: RemoteEvents, command: readonly string[] = relayCommand(name)) {
		this.name = name;
		this.events = events;
		this.command = command;
	}

	start(): void {
		if (this.started) throw new Error(`${this.name} already started`);
		this.started = true;
		this.connect();
	}

	isConnected(pid: number): boolean {
		return this.status.kind === "online" && this.states.has(pid);
	}

	send(target: SessionIdentity, command: Command): Promise<void> {
		const state = this.states.get(target.pid);
		if (!state || this.status.kind !== "online") return Promise.reject(new Error("session is not connected"));
		if (!sameSession(state, target)) return Promise.reject(new Error("session changed; refresh before sending"));
		return this.request("command", { target, command }).then(() => undefined);
	}

	async sample(targets: SampleTarget[]): Promise<Sample> {
		const wire = await this.request("sample", { targets });
		this.vitals = { host: wire.host, gpu: wire.gpu };
		this.interrupted = wire.interrupted;
		return { resources: new Map(wire.resources), piProcesses: wire.piProcesses, host: wire.host };
	}

	request<K extends RelayOp>(op: K, params: RelayOps[K]["params"], timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<RelayOps[K]["result"]> {
		const child = this.child;
		if (!child || this.status.kind !== "online") return Promise.reject(new Error(`${this.name} is ${this.status.kind}`));
		const id = this.nextId++;
		// A lost acknowledgement for a mutation is unknown, not a safe-to-retry failure.
		const command = op === "command" || op === "launch" || op === "recover" || op === "dismissRecovery" || (op === "git" &&
			["pull", "push", "pushSetUpstream", "switchBranch"].includes((params as RelayOps["git"]["params"]).method));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(command ? new UncertainCommandError(`No acknowledgement from ${this.name}; execution outcome is unknown`) : new Error(`${this.name} did not answer (${op})`));
				// A relay that stops answering stays stopped; a new link brings the host back.
				this.drop(child, `${this.name} stopped answering (${op} took over ${Math.round(timeoutMs / 1000)}s)`);
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, command });
			child.stdin.write(encodeRelay({ type: "request", id, op, params } as RelayRequest));
		});
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.retryTimer);
		clearTimeout(this.helloTimer);
		const child = this.child;
		this.child = undefined;
		child?.kill();
		this.failPending();
	}

	private connect(): void {
		this.status = { kind: "connecting", since: Date.now() };
		const child = spawn(this.command[0], this.command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		this.helloTimer = setTimeout(() => this.drop(child, `no answer from pi-dash-relay on ${this.name} within ${HELLO_TIMEOUT_MS / 1000}s`), HELLO_TIMEOUT_MS);
		const decoder = new LineDecoder();
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			let messages: unknown[];
			try {
				messages = decoder.push(chunk);
			} catch {
				this.drop(child, `${this.name} sent an invalid message`);
				return;
			}
			for (const raw of messages) {
				if (this.child !== child) return;
				const message = parseRelayMessage(sanitize(raw));
				// The relay greets first; anything else before that, or malformed, ends this link (not pi-dash).
				if (!message || (message.type !== "hello" && this.status.kind !== "online")) {
					this.drop(child, `${this.name} sent an invalid message`);
					return;
				}
				this.handle(child, message);
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.stdin.on("error", () => {});
		child.on("error", (error) => this.drop(child, error.message));
		child.on("close", (code) => this.drop(child, lastLine(stderr) ?? `relay exited with code ${code}`));
	}

	private handle(child: ChildProcessWithoutNullStreams, message: RelayMessage): void {
		switch (message.type) {
			case "hello":
				if (message.version !== RELAY_VERSION || message.bridge !== PROTOCOL_VERSION) {
					this.drop(child, `${this.name} runs relay v${message.version} / bridge v${message.bridge}, this pi-dash v${RELAY_VERSION} / v${PROTOCOL_VERSION}: run pi-dash-host add ${this.name}`);
					return;
				}
				clearTimeout(this.helloTimer);
				this.status = { kind: "online", since: Date.now(), hostname: message.hostname };
				this.retryMs = RETRY_MS.min;
				return;
			case "snapshot":
				this.states.set(message.pid, message.state);
				this.events.onState(message.pid, message.state);
				return;
			case "patch": {
				const previous = this.states.get(message.pid);
				if (!previous) return;
				const state = applyPatch(previous, message.changes);
				this.states.set(message.pid, state);
				this.events.onState(message.pid, state);
				return;
			}
			case "bye":
				this.events.onBye(message.pid, message.reason);
				return;
			case "disconnect":
				this.states.delete(message.pid);
				this.events.onDisconnect(message.pid, message.alive);
				return;
			case "incompatible":
				this.events.onIncompatible(message.pid, message.version);
				return;
			case "result": {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.ok) pending.resolve(message.value);
				else pending.reject(message.uncertain ? new UncertainCommandError(message.error) : new Error(message.error));
				return;
			}
		}
	}

	/** The link is gone (or unusable): report it once, then try again later. */
	private drop(child: ChildProcessWithoutNullStreams, error: string): void {
		if (this.child !== child) return;
		this.child = undefined;
		child.kill();
		clearTimeout(this.helloTimer);
		const wasOnline = this.status.kind === "online";
		this.status = { kind: "offline", since: Date.now(), error };
		this.vitals = undefined;
		this.interrupted = [];
		this.states.clear();
		this.failPending();
		if (wasOnline) this.events.onLost();
		if (this.closed) return;
		this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
		this.retryMs = Math.min(this.retryMs * 2, RETRY_MS.max);
	}

	private failPending(): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(pending.command ? new UncertainCommandError(`Lost ${this.name} before acknowledgement; execution outcome is unknown`) : new Error(`lost the connection to ${this.name}`));
		}
		this.pending.clear();
	}
}
