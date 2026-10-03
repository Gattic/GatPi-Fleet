// Discovers bridge sockets, keeps one connection per pi process, and sends commands.
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import {
	applyPatch,
	type BridgeMessage,
	type Command,
	encodeMessage,
	LineDecoder,
	PROTOCOL_VERSION,
	pidFromSocketName,
	type SessionState,
} from "../../protocol/index.ts";

export interface BridgeEvents {
	onState(pid: number, state: SessionState): void;
	onBye(pid: number, reason: string): void;
	onDisconnect(pid: number): void;
	onIncompatible(pid: number, version: number): void;
}

interface Pending {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface Connection {
	pid: number;
	/** Inode of the socket file, which a reloaded bridge recreates. */
	inode: number;
	socket: Socket;
	state?: SessionState;
	pending: Map<number, Pending>;
}

const COMMAND_TIMEOUT_MS = 5000;

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class BridgeHub {
	private readonly connections = new Map<number, Connection>();
	/** Sockets that spoke another protocol version, by pid: socket inode. */
	private readonly incompatible = new Map<number, number>();
	private nextId = 1;
	private readonly dir: string;
	private readonly events: BridgeEvents;

	constructor(dir: string, events: BridgeEvents) {
		this.dir = dir;
		this.events = events;
	}

	scan(): void {
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return;
		}
		for (const name of names) {
			const pid = pidFromSocketName(name);
			if (pid === undefined || this.connections.has(pid)) continue;
			const path = join(this.dir, name);
			if (!pidAlive(pid)) {
				// Left behind by a pi that crashed or was killed.
				try {
					unlinkSync(path);
				} catch {}
				continue;
			}
			let inode: number;
			try {
				inode = statSync(path).ino;
			} catch {
				continue;
			}
			// An incompatible bridge is tried again once it is replaced (/reload loads the bridge anew).
			if (this.incompatible.get(pid) === inode) continue;
			this.incompatible.delete(pid);
			this.open(pid, path, inode);
		}
	}

	send(pid: number, command: Command): Promise<void> {
		const connection = this.connections.get(pid);
		if (!connection?.state) return Promise.reject(new Error("session is not connected"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				connection.pending.delete(id);
				reject(new Error("no response from session"));
			}, COMMAND_TIMEOUT_MS);
			connection.pending.set(id, { resolve, reject, timer });
			connection.socket.write(encodeMessage({ type: "command", id, command }));
		});
	}

	isConnected(pid: number): boolean {
		return Boolean(this.connections.get(pid)?.state);
	}

	close(): void {
		for (const connection of this.connections.values()) connection.socket.destroy();
		this.connections.clear();
	}

	private open(pid: number, path: string, inode: number): void {
		const socket = connect(path);
		const connection: Connection = { pid, inode, socket, pending: new Map() };
		this.connections.set(pid, connection);
		const decoder = new LineDecoder();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			let messages: unknown[];
			try {
				messages = decoder.push(chunk);
			} catch {
				socket.destroy();
				return;
			}
			for (const message of messages) this.handle(connection, message as BridgeMessage);
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			if (this.connections.get(pid) === connection) this.connections.delete(pid);
			for (const pending of connection.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("session disconnected"));
			}
			if (connection.state) this.events.onDisconnect(pid);
		});
	}

	private handle(connection: Connection, message: BridgeMessage): void {
		switch (message.type) {
			case "hello":
				if (message.version !== PROTOCOL_VERSION) {
					this.incompatible.set(connection.pid, connection.inode);
					this.events.onIncompatible(connection.pid, message.version);
					connection.socket.destroy();
				}
				return;
			case "snapshot":
				connection.state = message.state;
				this.events.onState(connection.pid, connection.state);
				return;
			case "patch":
				if (!connection.state) return;
				connection.state = applyPatch(connection.state, message.changes);
				this.events.onState(connection.pid, connection.state);
				return;
			case "ack": {
				const pending = connection.pending.get(message.id);
				if (!pending) return;
				connection.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.ok) pending.resolve();
				else pending.reject(new Error(message.error ?? "command failed"));
				return;
			}
			case "bye":
				this.events.onBye(connection.pid, message.reason);
				return;
		}
	}
}
