// Shared, terminal-independent view of this machine and the remote hosts. Each client owns its lifecycle.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { socketDir } from "../protocol/index.ts";
import { BridgeHub, pidAlive } from "./collectors/bridges.ts";
import { GpuMonitor } from "./collectors/gpu.ts";
import { ProcSampler } from "./collectors/procs.ts";
import { QuotaMonitor } from "./collectors/quota.ts";
import { Dismissals } from "./dismissals.ts";
import { hostRows, rowCwd, rowIncarnation, rowLabel, SAMPLE_MS, type SessionRow, Store } from "./model/store.ts";
import { Network } from "./network.ts";
import { relayCommand } from "./remote/hosts.ts";
import { RemoteHost } from "./remote/host.ts";
import { UsageIndex } from "./usage/usage-index.ts";

export function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	return configured ? configured.replace(/^~(?=\/)/, homedir()) : join(homedir(), ".pi", "agent");
}

export class ManagerRuntime {
	readonly sessionRoot: string;
	readonly runtimeDir: string;
	readonly cacheDir: string;
	readonly store: Store;
	readonly hub: BridgeHub;
	readonly network: Network;
	readonly gpu = new GpuMonitor();
	readonly quota: QuotaMonitor;
	readonly usage: UsageIndex;
	private readonly dismissals: Dismissals;
	private readonly sampler = new ProcSampler();
	private readonly listeners = new Set<() => void>();
	/** Remote hosts with a sample request in flight. */
	private readonly sampling = new Set<string>();
	private timers: NodeJS.Timeout[] = [];

	/** `hosts`: remote hosts (hosts.json names) whose sessions to include; `relay` starts a host's relay (ssh by default). */
	constructor(options: { agent?: string; runtimeDir?: string; cacheDir?: string; cacheName?: string; hosts?: readonly string[]; relay?: (host: string) => readonly string[] } = {}) {
		const agent = options.agent ?? agentDir();
		this.sessionRoot = join(agent, "sessions");
		this.runtimeDir = options.runtimeDir ?? socketDir();
		this.cacheDir = options.cacheDir ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-dash");
		this.store = new Store(() => this.changed());
		this.dismissals = new Dismissals(join(this.runtimeDir, "dismissed"));
		this.hub = new BridgeHub(this.runtimeDir, {
			onState: (pid, state) => this.store.setState(pid, state),
			onBye: (pid, reason) => this.store.bye(pid, reason),
			onDisconnect: (pid) => this.store.disconnect(pid, pidAlive(pid)),
			onIncompatible: (pid, version) => this.store.incompatible(pid, version),
		});
		const remotes = new Map(
			(options.hosts ?? []).map((name) => [
				name,
				new RemoteHost(name, {
					onState: (pid, state) => this.store.setState(pid, state, name),
					onBye: (pid, reason) => this.store.bye(pid, reason, name),
					onDisconnect: (pid, alive) => this.store.disconnect(pid, alive, name),
					onIncompatible: (pid, version) => this.store.incompatible(pid, version, name),
					onLost: () => this.store.hostLost(name),
				}, (options.relay ?? relayCommand)(name)),
			]),
		);
		this.network = new Network(this.hub, remotes);
		this.quota = new QuotaMonitor(join(agent, "provider-failover-state.json"), join(agent, "auth.json"));
		this.usage = new UsageIndex({ sessionRoot: this.sessionRoot, cachePath: join(this.cacheDir, options.cacheName ?? "usage-index.json"), retentionMs: 30 * 86_400_000, onUpdate: () => this.changed() });
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void { for (const listener of this.listeners) listener(); }

	/** Removes an exited session's row here and in this user's other pi-dash processes (dashboard, gateway). */
	dismiss(row: SessionRow): void {
		if (row.exitedAt === undefined) throw new Error(`${rowLabel(row)} is still running`);
		this.dismissals.add(rowIncarnation(row));
		this.store.dismiss(row.key);
	}

	/** Removes the exited rows that another pi-dash process dismissed. */
	releaseDismissed(): void {
		const exited = [...this.store.rows.values()].filter((row) => row.exitedAt !== undefined);
		if (!exited.length) return;
		const dismissed = this.dismissals.dismissed(exited.map(rowIncarnation));
		for (const row of exited) if (dismissed.has(rowIncarnation(row))) this.store.dismiss(row.key);
	}

	start(): void {
		if (this.timers.length) throw new Error("manager already started");
		mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
		const sample = () => {
			this.store.applySample(this.sampler.sample(this.store.targets(), this.gpu.latest), this.gpu.latest, Date.now());
			for (const remote of this.network.remotes.values()) this.sampleRemote(remote);
		};
		const slow = () => { this.quota.poll(); void this.gpu.poll(); };
		// Usage comes from this machine's session files; remote sessions report theirs through their bridges.
		const usage = () => this.usage.scan([...new Set([...this.usage.cwds(), ...hostRows(this.store.ordered(), undefined).flatMap((row) => rowCwd(row) ?? [])])]);
		for (const remote of this.network.remotes.values()) remote.start();
		this.hub.scan();
		sample();
		slow();
		this.usage.start();
		usage();
		this.timers = [
			setInterval(() => { this.hub.scan(); this.releaseDismissed(); this.store.tick(Date.now()); this.changed(); }, 1000),
			setInterval(sample, SAMPLE_MS), setInterval(slow, 5000), setInterval(usage, 15_000),
		];
	}

	async close(): Promise<void> {
		for (const timer of this.timers) clearInterval(timer);
		this.timers = [];
		this.listeners.clear();
		this.hub.close();
		for (const remote of this.network.remotes.values()) remote.close();
		await this.usage.close();
	}

	private sampleRemote(remote: RemoteHost): void {
		if (remote.status.kind !== "online" || this.sampling.has(remote.name)) return;
		this.sampling.add(remote.name);
		const targets = this.store.targets(remote.name);
		remote
			.sample(targets)
			.then(
				(sample) => this.store.applyRemoteSample(remote.name, sample, targets, Date.now()),
				// A lost link shows in the host's status; its sessions were marked by onLost.
				() => {},
			)
			.finally(() => this.sampling.delete(remote.name));
	}
}
