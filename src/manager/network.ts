// Where a session's commands go: this machine's bridges, or the relay of the remote host it runs on.
import type { Command } from "../protocol/index.ts";
import type { BridgeHub } from "./collectors/bridges.ts";
import type { SessionRow } from "./model/store.ts";
import type { RemoteHost } from "./remote/host.ts";

export class Network {
	readonly local: BridgeHub;
	/** By hosts.json name. */
	readonly remotes: ReadonlyMap<string, RemoteHost>;

	constructor(local: BridgeHub, remotes: ReadonlyMap<string, RemoteHost>) {
		this.local = local;
		this.remotes = remotes;
	}

	isConnected(row: SessionRow): boolean {
		return row.host === undefined ? this.local.isConnected(row.pid) : (this.remotes.get(row.host)?.isConnected(row.pid) ?? false);
	}

	async send(row: SessionRow, command: Command): Promise<void> {
		if (!row.bridge) throw new Error("session has no bridge");
		if (row.host === undefined) return this.local.send(row.bridge, command);
		return this.remote(row.host).send(row.bridge, command);
	}

	remote(host: string): RemoteHost {
		const remote = this.remotes.get(host);
		if (!remote) throw new Error(`${host} is not a configured host`);
		return remote;
	}
}
