// /proc + cgroup sampler: CPU, memory and GPU memory per pi session, split
// into the pi process itself (direct) and everything it caused (indirect).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { GpuSample } from "./gpu.ts";

export interface ProcStat {
	pid: number;
	ppid: number;
	comm: string;
	ttyNr: number;
	/** Own CPU ticks (utime + stime). */
	own: number;
	/** CPU ticks of reaped children (cutime + cstime). */
	child: number;
	starttime: number;
	rss: number;
}

export function parseStat(text: string, pageSize: number): ProcStat | undefined {
	const open = text.indexOf("(");
	const close = text.lastIndexOf(")");
	if (open < 0 || close < 0) return undefined;
	const fields = text.slice(close + 2).split(" ");
	return {
		pid: Number(text.slice(0, open).trim()),
		comm: text.slice(open + 1, close),
		ppid: Number(fields[1]),
		ttyNr: Number(fields[4]),
		own: Number(fields[11]) + Number(fields[12]),
		child: Number(fields[13]) + Number(fields[14]),
		starttime: Number(fields[19]),
		rss: Number(fields[21]) * pageSize,
	};
}

export interface Consumer {
	kind: "self" | "process" | "unit";
	label: string;
	cpu: number;
	rss: number;
}

/** Work a session started in the background, recognised by its command line. */
export interface Background {
	/** GatPi-Harness `bg_run` job supervisor, or an RPC subagent (`pi --mode rpc`). */
	kind: "job" | "subagent";
	/** Job name or subagent role. */
	label: string;
	/** Epoch ms. */
	startedAt: number;
}

export interface ResourceSample {
	directCpu: number;
	indirectCpu: number;
	directMem: number;
	indirectMem: number;
	directGpuMem: number;
	indirectGpuMem: number;
	/** Largest consumers by CPU, then memory. */
	consumers: Consumer[];
	/** Background jobs and subagents among the session's processes, oldest first. */
	background: Background[];
}

export interface SampleTarget {
	key: string;
	pid: number;
	/** Enables attribution of detached processes that inherited PI_SESSION_ID. */
	sessionId?: string;
}

/** An interactive pi process (has a terminal and no pi ancestor). */
export interface PiProcess {
	pid: number;
	/** Process start, epoch ms. */
	startedAt: number;
	cwd?: string;
	sty?: string;
	window?: string;
}

export interface HostSample {
	cpu: number;
	cores: number;
	memUsed: number;
	memTotal: number;
	load1: number;
}

export interface Sample {
	resources: Map<string, ResourceSample>;
	piProcesses: PiProcess[];
	host: HostSample;
}

interface UnitStat {
	name: string;
	clientPid: number;
	usageUsec: number;
	memory: number;
	pids: number[];
}

interface ProcEnv {
	sessionId?: string;
	sty?: string;
	window?: string;
}

const TOP_CONSUMERS = 6;
const UNIT_PATTERN = /^run-p(\d+)-i\d+\.(?:service|scope)$/;

function getconf(name: string, fallback: number): number {
	try {
		return Number(execFileSync("getconf", [name], { encoding: "utf8" }).trim()) || fallback;
	} catch {
		return fallback;
	}
}

/** A string field of a small JSON file, if the file and field exist. */
function jsonString(path: string, field: string): string | undefined {
	try {
		const value = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[field];
		return typeof value === "string" && value ? value : undefined;
	} catch {
		return undefined;
	}
}

function procKey(stat: ProcStat): string {
	return `${stat.pid}:${stat.starttime}`;
}

export class ProcSampler {
	private readonly procRoot: string;
	private readonly appSlice: string;
	private readonly hz = getconf("CLK_TCK", 100);
	private readonly pageSize = getconf("PAGESIZE", 4096);
	private prevProcs = new Map<string, ProcStat>();
	private prevSets = new Map<string, Set<string>>();
	private prevUnits = new Map<string, number>();
	private prevUptimeTicks?: number;
	private prevHostCpu?: { total: number; idle: number };
	/** System boot time, epoch seconds (process start times count from it). */
	private bootTime?: number;
	private readonly envCache = new Map<string, ProcEnv>();
	private readonly argsCache = new Map<string, string[]>();
	/** null: not background work. */
	private readonly backgroundCache = new Map<string, Background | null>();

	constructor(options: { procRoot?: string; appSlice?: string } = {}) {
		this.procRoot = options.procRoot ?? "/proc";
		const uid = process.getuid?.() ?? 0;
		this.appSlice = options.appSlice ?? `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
	}

	sample(targets: readonly SampleTarget[], gpu: GpuSample | undefined): Sample {
		const procs = this.readProcs();
		const uptimeTicks = this.readUptime() * this.hz;
		const elapsedTicks = this.prevUptimeTicks === undefined ? 0 : uptimeTicks - this.prevUptimeTicks;
		const children = new Map<number, number[]>();
		for (const stat of procs.values()) {
			const list = children.get(stat.ppid);
			if (list) list.push(stat.pid);
			else children.set(stat.ppid, [stat.pid]);
		}
		const units = this.readUnits();
		const unitPids = new Set(units.flatMap((unit) => unit.pids));

		const descendantsOf = (root: number): Set<number> => {
			const found = new Set<number>();
			const stack = [...(children.get(root) ?? [])];
			while (stack.length) {
				const pid = stack.pop() as number;
				if (found.has(pid)) continue;
				found.add(pid);
				stack.push(...(children.get(pid) ?? []));
			}
			return found;
		};

		const trees = new Map<string, Set<number>>();
		const claimed = new Set<number>();
		for (const target of targets) {
			if (!procs.has(target.pid)) continue;
			const tree = descendantsOf(target.pid);
			trees.set(target.key, tree);
			claimed.add(target.pid);
			for (const pid of tree) claimed.add(pid);
		}
		const bySession = new Map<string, number[]>();
		if (targets.some((target) => target.sessionId)) {
			for (const stat of procs.values()) {
				if (claimed.has(stat.pid) || unitPids.has(stat.pid) || stat.ppid === 2 || stat.pid === 2) continue;
				const sessionId = this.envOf(stat).sessionId;
				if (!sessionId) continue;
				const list = bySession.get(sessionId);
				if (list) list.push(stat.pid);
				else bySession.set(sessionId, [stat.pid]);
			}
		}

		const resources = new Map<string, ResourceSample>();
		const nextSets = new Map<string, Set<string>>();
		const nextUnits = new Map<string, number>();
		for (const target of targets) {
			const root = procs.get(target.pid);
			const tree = trees.get(target.key);
			if (!root || !tree) continue;
			const members = new Set(tree);
			for (const pid of target.sessionId ? (bySession.get(target.sessionId) ?? []) : []) members.add(pid);
			const rootKey = procKey(root);
			const prevRoot = this.prevProcs.get(rootKey);
			const memberKeys = new Set<string>();
			const consumers: Consumer[] = [];
			const background: Background[] = [];
			const cpuOf = (ticks: number) => (elapsedTicks > 0 ? Math.max(0, ticks) / elapsedTicks : 0);

			const directTicks = prevRoot ? root.own - prevRoot.own : 0;
			let indirectTicks = prevRoot ? root.child - prevRoot.child : 0;
			let indirectMem = 0;
			for (const pid of members) {
				const stat = procs.get(pid);
				if (!stat) continue;
				const key = procKey(stat);
				memberKeys.add(key);
				const prev = this.prevProcs.get(key);
				const started = this.prevUptimeTicks !== undefined && stat.starttime > this.prevUptimeTicks;
				let ownDelta = 0;
				if (prev) {
					ownDelta = stat.own - prev.own;
					indirectTicks += stat.own + stat.child - prev.own - prev.child;
				} else if (started) {
					ownDelta = stat.own;
					indirectTicks += stat.own + stat.child;
				}
				indirectMem += stat.rss;
				consumers.push({ kind: "process", label: this.labelOf(stat), cpu: cpuOf(ownDelta), rss: stat.rss });
				const work = this.backgroundOf(stat);
				if (work) background.push(work);
			}
			// A process that exited since the last tick has its final CPU time folded
			// into its parent's cutime; remove the part already counted.
			for (const key of this.prevSets.get(target.key) ?? []) {
				if (procs.get(Number(key.split(":")[0])) && memberKeys.has(key)) continue;
				const prev = this.prevProcs.get(key);
				const alive = prev && procs.get(prev.pid)?.starttime === prev.starttime;
				if (prev && !alive) indirectTicks -= prev.own + prev.child;
			}
			nextSets.set(target.key, memberKeys);

			let unitCpu = 0;
			const memberPids = new Set([...members, target.pid]);
			const ownedUnitPids = new Set<number>();
			for (const unit of units) {
				if (!memberPids.has(unit.clientPid)) continue;
				const prevUsage = this.prevUnits.get(unit.name);
				const cpu = prevUsage !== undefined && elapsedTicks > 0 ? Math.max(0, unit.usageUsec - prevUsage) / 1e6 / (elapsedTicks / this.hz) : 0;
				unitCpu += cpu;
				indirectMem += unit.memory;
				for (const pid of unit.pids) ownedUnitPids.add(pid);
				const main = unit.pids.map((pid) => procs.get(pid)).find(Boolean);
				consumers.push({ kind: "unit", label: `${unit.name.replace(/\.(service|scope)$/, "")} ${main ? this.labelOf(main) : ""}`.trim(), cpu, rss: unit.memory });
			}

			const directCpu = cpuOf(directTicks);
			consumers.push({ kind: "self", label: "pi (self)", cpu: directCpu, rss: root.rss });
			consumers.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);

			let directGpuMem = 0;
			let indirectGpuMem = 0;
			for (const [pid, bytes] of gpu?.processes ?? []) {
				if (pid === target.pid) directGpuMem += bytes;
				else if (members.has(pid) || ownedUnitPids.has(pid)) indirectGpuMem += bytes;
			}

			resources.set(target.key, {
				directCpu,
				indirectCpu: cpuOf(indirectTicks) + unitCpu,
				directMem: root.rss,
				indirectMem,
				directGpuMem,
				indirectGpuMem,
				consumers: consumers.slice(0, TOP_CONSUMERS),
				background: background.sort((a, b) => a.startedAt - b.startedAt),
			});
		}
		for (const unit of units) nextUnits.set(unit.name, unit.usageUsec);

		this.prevProcs = new Map([...procs.values()].map((stat) => [procKey(stat), stat]));
		this.prevSets = nextSets;
		this.prevUnits = nextUnits;
		this.prevUptimeTicks = uptimeTicks;
		this.pruneCaches();
		return { resources, piProcesses: this.findPiProcesses(procs), host: this.readHost() };
	}

	private readProcs(): Map<number, ProcStat> {
		const procs = new Map<number, ProcStat>();
		let names: string[] = [];
		try {
			names = readdirSync(this.procRoot);
		} catch {
			return procs;
		}
		for (const name of names) {
			if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
			try {
				const stat = parseStat(readFileSync(join(this.procRoot, name, "stat"), "utf8"), this.pageSize);
				if (stat) procs.set(stat.pid, stat);
			} catch {}
		}
		return procs;
	}

	private readUptime(): number {
		try {
			return Number(readFileSync(join(this.procRoot, "uptime"), "utf8").split(" ")[0]);
		} catch {
			return 0;
		}
	}

	private readUnits(): UnitStat[] {
		let names: string[];
		try {
			names = readdirSync(this.appSlice);
		} catch {
			return [];
		}
		const units: UnitStat[] = [];
		for (const name of names) {
			const match = UNIT_PATTERN.exec(name);
			if (!match) continue;
			const dir = join(this.appSlice, name);
			try {
				const cpuStat = readFileSync(join(dir, "cpu.stat"), "utf8");
				units.push({
					name,
					clientPid: Number(match[1]),
					usageUsec: Number(/usage_usec (\d+)/.exec(cpuStat)?.[1] ?? 0),
					memory: Number(readFileSync(join(dir, "memory.current"), "utf8").trim()),
					pids: readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number),
				});
			} catch {}
		}
		return units;
	}

	private envOf(stat: ProcStat): ProcEnv {
		const key = procKey(stat);
		const cached = this.envCache.get(key);
		if (cached) return cached;
		const env: ProcEnv = {};
		try {
			for (const entry of readFileSync(join(this.procRoot, String(stat.pid), "environ"), "utf8").split("\0")) {
				if (entry.startsWith("PI_SESSION_ID=")) env.sessionId = entry.slice(14);
				else if (entry.startsWith("STY=")) env.sty = entry.slice(4);
				else if (entry.startsWith("WINDOW=")) env.window = entry.slice(7);
			}
		} catch {}
		this.envCache.set(key, env);
		return env;
	}

	private argsOf(stat: ProcStat): string[] {
		const key = procKey(stat);
		let args = this.argsCache.get(key);
		if (args === undefined) {
			try {
				args = readFileSync(join(this.procRoot, String(stat.pid), "cmdline"), "utf8").split("\0").filter(Boolean);
			} catch {
				args = [];
			}
			this.argsCache.set(key, args);
		}
		return args;
	}

	private labelOf(stat: ProcStat): string {
		const args = this.argsOf(stat);
		const program = args[0]?.split("/").pop() ?? stat.comm;
		return [program, ...args.slice(1)].join(" ").slice(0, 80) || stat.comm;
	}

	/**
	 * A GatPi-Harness job supervisor runs `managed-job-supervisor.js <cwd>/.pi/jobs/<job>.launch.json`, and its
	 * name is in `<job>.json`. A subagent runs `pi --mode rpc --session-dir <cwd>/.pi/subagents/rpc-sessions/<id>`,
	 * and its role is in `<cwd>/.pi/subagents/records/<id>.json`.
	 */
	private backgroundOf(stat: ProcStat): Background | undefined {
		const key = procKey(stat);
		const cached = this.backgroundCache.get(key);
		if (cached !== undefined) return cached ?? undefined;
		const args = this.argsOf(stat);
		const supervisor = args.findIndex((arg) => arg.endsWith("/managed-job-supervisor.js"));
		const launch = supervisor >= 0 ? args[supervisor + 1] : undefined;
		if (launch?.endsWith(".launch.json")) {
			const record = launch.replace(/\.launch\.json$/, ".json");
			const name = jsonString(record, "name");
			const work: Background = { kind: "job", label: name ?? basename(record, ".json"), startedAt: this.startedAt(stat) };
			// The job record is written just after the supervisor starts; look again until it has the name.
			if (name) this.backgroundCache.set(key, work);
			return work;
		}
		const mode = args.indexOf("--mode");
		if (mode < 0 || args[mode + 1] !== "rpc") {
			this.backgroundCache.set(key, null);
			return undefined;
		}
		const sessionDir = args.includes("--session-dir") ? args[args.indexOf("--session-dir") + 1] : undefined;
		const id = sessionDir ? basename(sessionDir) : undefined;
		const role = sessionDir && id ? jsonString(join(dirname(dirname(sessionDir)), "records", `${id}.json`), "role") : undefined;
		const work: Background = { kind: "subagent", label: role ?? id ?? "subagent", startedAt: this.startedAt(stat) };
		this.backgroundCache.set(key, work);
		return work;
	}

	/** Start time of a process in epoch ms. */
	private startedAt(stat: ProcStat): number {
		if (this.bootTime === undefined) {
			try {
				this.bootTime = Number(/^btime (\d+)$/m.exec(readFileSync(join(this.procRoot, "stat"), "utf8"))?.[1] ?? 0);
			} catch {
				this.bootTime = 0;
			}
		}
		return (this.bootTime + stat.starttime / this.hz) * 1000;
	}

	private findPiProcesses(procs: Map<number, ProcStat>): PiProcess[] {
		const result: PiProcess[] = [];
		for (const stat of procs.values()) {
			if (stat.comm !== "pi" || stat.ttyNr === 0) continue;
			let ancestor = procs.get(stat.ppid);
			let nested = false;
			while (ancestor && ancestor.pid > 1) {
				if (ancestor.comm === "pi") {
					nested = true;
					break;
				}
				ancestor = procs.get(ancestor.ppid);
			}
			if (nested) continue;
			let cwd: string | undefined;
			try {
				cwd = readlinkSync(join(this.procRoot, String(stat.pid), "cwd"));
			} catch {}
			const env = this.envOf(stat);
			result.push({ pid: stat.pid, startedAt: this.startedAt(stat), cwd, sty: env.sty, window: env.window });
		}
		return result;
	}

	private readHost(): HostSample {
		let cpu = 0;
		let cores = 1;
		try {
			const lines = readFileSync(join(this.procRoot, "stat"), "utf8").split("\n");
			const fields = lines[0].split(/\s+/).slice(1, 9).map(Number);
			const idle = fields[3] + fields[4];
			const total = fields.reduce((sum, value) => sum + value, 0);
			if (this.prevHostCpu && total > this.prevHostCpu.total) {
				cpu = 1 - (idle - this.prevHostCpu.idle) / (total - this.prevHostCpu.total);
			}
			this.prevHostCpu = { total, idle };
			cores = lines.filter((line) => /^cpu\d+ /.test(line)).length || 1;
		} catch {}
		let memTotal = 0;
		let memAvailable = 0;
		try {
			const meminfo = readFileSync(join(this.procRoot, "meminfo"), "utf8");
			memTotal = Number(/MemTotal:\s+(\d+)/.exec(meminfo)?.[1] ?? 0) * 1024;
			memAvailable = Number(/MemAvailable:\s+(\d+)/.exec(meminfo)?.[1] ?? 0) * 1024;
		} catch {}
		let load1 = 0;
		try {
			load1 = Number(readFileSync(join(this.procRoot, "loadavg"), "utf8").split(" ")[0]);
		} catch {}
		return { cpu, cores, memUsed: memTotal - memAvailable, memTotal, load1 };
	}

	private pruneCaches(): void {
		for (const cache of [this.envCache, this.argsCache, this.backgroundCache]) {
			for (const key of cache.keys()) if (!this.prevProcs.has(key)) cache.delete(key);
		}
	}
}
