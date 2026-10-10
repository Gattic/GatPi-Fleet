// Shared, terminal-independent view of the host. Each client owns its lifecycle.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { socketDir } from "../protocol/index.ts";
import { BridgeHub } from "./collectors/bridges.ts";
import { GpuMonitor } from "./collectors/gpu.ts";
import { ProcSampler } from "./collectors/procs.ts";
import { QuotaMonitor } from "./collectors/quota.ts";
import { rowCwd, SAMPLE_MS, Store } from "./model/store.ts";
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
	readonly gpu = new GpuMonitor();
	readonly quota: QuotaMonitor;
	readonly usage: UsageIndex;
	private readonly sampler = new ProcSampler();
	private readonly listeners = new Set<() => void>();
	private timers: NodeJS.Timeout[] = [];

	constructor(options: { agent?: string; runtimeDir?: string; cacheDir?: string; cacheName?: string } = {}) {
		const agent = options.agent ?? agentDir();
		this.sessionRoot = join(agent, "sessions");
		this.runtimeDir = options.runtimeDir ?? socketDir();
		this.cacheDir = options.cacheDir ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-dash");
		this.store = new Store(() => this.changed());
		this.hub = new BridgeHub(this.runtimeDir, {
			onState: (pid, state) => this.store.setState(pid, state),
			onBye: (pid, reason) => this.store.bye(pid, reason),
			onDisconnect: (pid) => this.store.disconnect(pid),
			onIncompatible: (pid, version) => this.store.incompatible(pid, version),
		});
		this.quota = new QuotaMonitor(join(agent, "provider-failover-state.json"), join(agent, "auth.json"));
		this.usage = new UsageIndex({ sessionRoot: this.sessionRoot, cachePath: join(this.cacheDir, options.cacheName ?? "usage-index.json"), retentionMs: 30 * 86_400_000, onUpdate: () => this.changed() });
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void { for (const listener of this.listeners) listener(); }

	start(): void {
		if (this.timers.length) throw new Error("manager already started");
		mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
		const sample = () => this.store.applySample(this.sampler.sample(this.store.targets(), this.gpu.latest), this.gpu.latest, Date.now());
		const slow = () => { this.quota.poll(); void this.gpu.poll(); };
		const usage = () => this.usage.scan([...new Set([...this.usage.cwds(), ...this.store.ordered().flatMap((row) => rowCwd(row) ?? [])])]);
		this.hub.scan();
		sample();
		slow();
		this.usage.start();
		usage();
		this.timers = [
			setInterval(() => { this.hub.scan(); this.store.tick(Date.now()); this.changed(); }, 1000),
			setInterval(sample, SAMPLE_MS), setInterval(slow, 5000), setInterval(usage, 15_000),
		];
	}

	async close(): Promise<void> {
		for (const timer of this.timers) clearInterval(timer);
		this.timers = [];
		this.listeners.clear();
		this.hub.close();
		await this.usage.close();
	}
}
