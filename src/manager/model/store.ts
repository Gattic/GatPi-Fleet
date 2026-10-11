// Dashboard state: one row per interactive pi process on this machine or a remote host, stable
// slots, and rolling resource/activity history.
import { basename } from "node:path";
import type { SessionState, TimelineEntry } from "../../protocol/index.ts";
import type { GpuSample } from "../collectors/gpu.ts";
import type { HostSample, PiProcess, ResourceSample, Sample, SampleTarget } from "../collectors/procs.ts";
import { Series } from "./series.ts";
import { deriveStatus, isAlert, laneState, type Status, timelineLane } from "./status.ts";

export const SAMPLE_MS = 2000;
/** One hour of 2-second samples. */
const HISTORY = 1800;
const MAX_SLOTS = 9;
const ALERT_MS = 15_000;

export interface SessionRow {
	/** Unique across hosts (rowKey). */
	key: string;
	/** The remote host (its name in hosts.json) running this pi; absent on this machine. */
	host?: string;
	pid: number;
	slot?: number;
	bridge?: SessionState;
	connected: boolean;
	/** What /proc knows about this pi (used for sessions without a bridge). */
	proc?: PiProcess;
	exitedAt?: number;
	exitReason?: string;
	/** Bridge protocol version when it does not match ours. */
	incompatibleVersion?: number;
	resources?: ResourceSample;
	cpuDirect: Series;
	cpuIndirect: Series;
	memDirect: Series;
	memIndirect: Series;
	lane: Series;
	status: Status;
	alertUntil?: number;
}

interface PendingLaunch {
	slot?: number;
	/** Key of the exited row the new session replaces. */
	replaces?: string;
	at: number;
}

/** The pid on this machine; `host:pid` on a remote host. */
export function rowKey(pid: number, host?: string): string {
	return host === undefined ? String(pid) : `${host}:${pid}`;
}

/**
 * One run of a session, the same in every pi-dash process that sees it: the bridge's random
 * incarnation, or for a pi without one, its process start time.
 */
export function rowIncarnation(row: SessionRow): string {
	const id = row.bridge ? `${row.pid}:${row.bridge.sessionId}:${row.bridge.instanceId}` : `${row.pid}:proc:${row.proc?.startedAt ?? 0}`;
	return row.host === undefined ? id : `${row.host}:${id}`;
}

/** A screen the dashboard launched on `host`: only a session on that host can claim it. */
function launchKey(name: string, host: string | undefined): string {
	return host === undefined ? name : `${host}:${name}`;
}

export function screenName(sty: string | undefined): string | undefined {
	return sty ? sty.slice(sty.indexOf(".") + 1) : undefined;
}

export function rowCwd(row: SessionRow): string | undefined {
	return row.bridge?.cwd ?? row.proc?.cwd;
}

/** Project directories of sessions that are still running. */
export function openCwds(rows: readonly SessionRow[]): string[] {
	return rows.flatMap((row) => {
		const cwd = rowCwd(row);
		return cwd && row.exitedAt === undefined ? [cwd] : [];
	});
}

export function rowSty(row: SessionRow): string | undefined {
	return row.bridge?.sty ?? row.proc?.sty;
}

export function rowWindow(row: SessionRow): string | undefined {
	return row.bridge?.window ?? row.proc?.window;
}

/** Rows of one host: `undefined` is this machine. */
export function hostRows(rows: readonly SessionRow[], host: string | undefined): SessionRow[] {
	return rows.filter((row) => row.host === host);
}

export function rowLabel(row: SessionRow): string {
	const cwd = rowCwd(row);
	const label = row.bridge?.name || (cwd ? basename(cwd) : `pi ${row.pid}`);
	return row.host === undefined ? label : `${label}@${row.host}`;
}

export function rowCpu(row: SessionRow): number {
	return (row.resources?.directCpu ?? 0) + (row.resources?.indirectCpu ?? 0);
}

/** One lane sample per SAMPLE_MS up to `now`, from the bridge's timeline (what happened before the dashboard saw the session). */
export function laneFromTimeline(timeline: readonly TimelineEntry[], now: number): Series {
	const lane = new Series(HISTORY);
	if (!timeline.length) return lane;
	let index = 0;
	for (let at = Math.max(timeline[0].at, now - (HISTORY - 1) * SAMPLE_MS); at <= now; at += SAMPLE_MS) {
		while (index + 1 < timeline.length && timeline[index + 1].at <= at) index++;
		lane.push(timelineLane(timeline[index].state));
	}
	return lane;
}

export class Store {
	readonly rows = new Map<string, SessionRow>();
	readonly hostCpu = new Series(HISTORY);
	readonly hostMem = new Series(HISTORY);
	readonly gpuUtil = new Series(HISTORY);
	host?: HostSample;
	gpu?: GpuSample;
	private readonly pendingLaunches = new Map<string, PendingLaunch>();
	private readonly onChange: () => void;

	constructor(onChange: () => void) {
		this.onChange = onChange;
	}

	ordered(): SessionRow[] {
		return [...this.rows.values()].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || (a.host ?? "").localeCompare(b.host ?? "") || a.pid - b.pid);
	}

	bySlot(slot: number): SessionRow | undefined {
		return [...this.rows.values()].find((row) => row.slot === slot);
	}

	/** A session launched by the dashboard in screen `name` on `host` should take `slot` (and replace the exited row `replaces` there). */
	expectLaunch(name: string, slot?: number, replaces?: string, host?: string): void {
		this.pendingLaunches.set(launchKey(name, host), { slot, replaces, at: Date.now() });
	}

	/** What to sample on `host` (this machine when undefined): its running sessions, keyed by pid. */
	targets(host?: string): SampleTarget[] {
		return [...this.rows.values()]
			.filter((row) => row.host === host && row.exitedAt === undefined)
			.map((row) => ({ key: String(row.pid), pid: row.pid, sessionId: row.bridge?.sessionId }));
	}

	setState(pid: number, state: SessionState, host?: string): void {
		const row = this.rows.get(rowKey(pid, host)) ?? this.create(pid, state.sty, host);
		// Until now this row only had /proc samples; the bridge knows the last hour.
		if (!row.bridge) row.lane = laneFromTimeline(state.timeline, Date.now());
		row.bridge = state;
		row.incompatibleVersion = undefined;
		row.connected = true;
		row.exitedAt = undefined;
		row.exitReason = undefined;
		this.refreshStatus(row, Date.now());
		this.onChange();
	}

	bye(pid: number, reason: string, host?: string): void {
		const row = this.rows.get(rowKey(pid, host));
		if (!row) return;
		row.connected = false;
		if (reason === "quit") {
			row.exitedAt = Date.now();
			row.exitReason = reason;
		}
		this.refreshStatus(row, Date.now());
		this.onChange();
	}

	/** `alive`: whether the pi process still runs (on its host). */
	disconnect(pid: number, alive: boolean, host?: string): void {
		const row = this.rows.get(rowKey(pid, host));
		if (!row) return;
		row.connected = false;
		if (row.exitedAt === undefined && !alive) row.exitedAt = Date.now();
		this.refreshStatus(row, Date.now());
		this.onChange();
	}

	incompatible(pid: number, version: number, host?: string): void {
		const row = this.rows.get(rowKey(pid, host)) ?? this.create(pid, undefined, host);
		row.incompatibleVersion = version;
		this.onChange();
	}

	dismiss(key: string): void {
		this.rows.delete(key);
		this.onChange();
	}

	acknowledge(key: string): void {
		const row = this.rows.get(key);
		if (row) row.alertUntil = undefined;
	}

	/** A sample of this machine. */
	applySample(sample: Sample, gpu: GpuSample | undefined, now: number): void {
		this.host = sample.host;
		this.gpu = gpu;
		this.hostCpu.push(sample.host.cpu);
		this.hostMem.push(sample.host.memTotal ? sample.host.memUsed / sample.host.memTotal : 0);
		this.gpuUtil.push(gpu?.utilization ?? Number.NaN);
		// Taken just before, synchronously, for targets(): every running row was a target.
		this.applyProcesses(sample, undefined, this.targets(), now);
	}

	/** A sample of a remote host's processes, taken for `targets` (rows may have come and gone since it was asked for). */
	applyRemoteSample(host: string, sample: Sample, targets: readonly SampleTarget[], now: number): void {
		this.applyProcesses(sample, host, targets, now);
	}

	/** The link to `host` is down: its pi processes are unknown until it is back. */
	hostLost(host: string): void {
		for (const row of [...this.rows.values()]) {
			if (row.host !== host || row.exitedAt !== undefined) continue;
			if (!row.bridge) {
				this.rows.delete(row.key);
				continue;
			}
			row.connected = false;
			row.resources = undefined;
			this.refreshStatus(row, Date.now());
		}
		this.onChange();
	}

	private applyProcesses(sample: Sample, host: string | undefined, targets: readonly SampleTarget[], now: number): void {
		const sampled = new Set(targets.map((target) => target.pid));
		const live = new Map(sample.piProcesses.map((proc) => [proc.pid, proc]));
		for (const proc of live.values()) {
			const row = this.rows.get(rowKey(proc.pid, host)) ?? this.create(proc.pid, proc.sty, host);
			row.proc = proc;
		}
		const rows = [...this.rows.values()].filter((row) => row.host === host);
		for (const row of rows) {
			if (row.exitedAt !== undefined) continue;
			if (!row.bridge && !live.has(row.pid)) {
				// A pi without a bridge is only known through /proc.
				this.rows.delete(row.key);
				continue;
			}
			// Only live targets have resources; a row that was not a target says nothing yet.
			if (row.bridge && !row.connected && sampled.has(row.pid) && !sample.resources.has(String(row.pid))) row.exitedAt = now;
		}
		for (const row of rows) {
			if (!this.rows.has(row.key)) continue;
			const resources = row.exitedAt === undefined ? sample.resources.get(String(row.pid)) : undefined;
			row.resources = resources;
			row.cpuDirect.push(resources?.directCpu ?? Number.NaN);
			row.cpuIndirect.push(resources?.indirectCpu ?? Number.NaN);
			row.memDirect.push(resources?.directMem ?? Number.NaN);
			row.memIndirect.push(resources?.indirectMem ?? Number.NaN);
			this.refreshStatus(row, now);
			row.lane.push(laneState(row.status));
		}
		for (const [name, pending] of this.pendingLaunches) {
			if (now - pending.at > 60_000) this.pendingLaunches.delete(name);
		}
		this.onChange();
	}

	/** Re-derive statuses (timers, stall detection) between samples. */
	tick(now: number): void {
		for (const row of this.rows.values()) this.refreshStatus(row, now);
	}

	private refreshStatus(row: SessionRow, now: number): void {
		const previous = row.status;
		row.status = deriveStatus({ bridge: row.bridge, connected: row.connected, exitedAt: row.exitedAt, cpu: rowCpu(row) }, now);
		// Connecting (or reconnecting after /reload) reveals a state; it does not enter one.
		const revealed = previous.kind === "unbridged" || previous.kind === "connecting";
		if (previous.kind !== row.status.kind && !revealed && isAlert(row.status.kind)) row.alertUntil = now + ALERT_MS;
		if (row.alertUntil !== undefined && row.alertUntil < now) row.alertUntil = undefined;
	}

	private create(pid: number, sty: string | undefined, host: string | undefined): SessionRow {
		const name = screenName(sty);
		const pending = name ? this.pendingLaunches.get(launchKey(name, host)) : undefined;
		if (pending && name) {
			this.pendingLaunches.delete(launchKey(name, host));
			if (pending.replaces !== undefined) this.rows.delete(pending.replaces);
		}
		const used = new Set([...this.rows.values()].map((row) => row.slot));
		let slot = pending?.slot !== undefined && !used.has(pending.slot) ? pending.slot : undefined;
		for (let candidate = 1; slot === undefined && candidate <= MAX_SLOTS; candidate++) {
			if (!used.has(candidate)) slot = candidate;
		}
		const row: SessionRow = {
			key: rowKey(pid, host),
			host,
			pid,
			slot,
			connected: false,
			cpuDirect: new Series(HISTORY),
			cpuIndirect: new Series(HISTORY),
			memDirect: new Series(HISTORY),
			memIndirect: new Series(HISTORY),
			lane: new Series(HISTORY),
			status: { kind: "unbridged", label: "no bridge" },
		};
		this.rows.set(row.key, row);
		return row;
	}
}
