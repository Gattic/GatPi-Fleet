// Dashboard state: one row per interactive pi process, stable slots, and
// rolling resource/activity history.
import { basename } from "node:path";
import type { SessionState, TimelineEntry } from "../../protocol/index.ts";
import { pidAlive } from "../collectors/bridges.ts";
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
	replacesPid?: number;
	at: number;
}

export function screenName(sty: string | undefined): string | undefined {
	return sty ? sty.slice(sty.indexOf(".") + 1) : undefined;
}

export function rowCwd(row: SessionRow): string | undefined {
	return row.bridge?.cwd ?? row.proc?.cwd;
}

export function rowSty(row: SessionRow): string | undefined {
	return row.bridge?.sty ?? row.proc?.sty;
}

export function rowWindow(row: SessionRow): string | undefined {
	return row.bridge?.window ?? row.proc?.window;
}

export function rowLabel(row: SessionRow): string {
	const cwd = rowCwd(row);
	return row.bridge?.name || (cwd ? basename(cwd) : `pi ${row.pid}`);
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
	readonly rows = new Map<number, SessionRow>();
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
		return [...this.rows.values()].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || a.pid - b.pid);
	}

	bySlot(slot: number): SessionRow | undefined {
		return [...this.rows.values()].find((row) => row.slot === slot);
	}

	/** A session launched by the dashboard in screen `name` should take `slot` (and replace an exited row). */
	expectLaunch(name: string, slot?: number, replacesPid?: number): void {
		this.pendingLaunches.set(name, { slot, replacesPid, at: Date.now() });
	}

	targets(): SampleTarget[] {
		return [...this.rows.values()]
			.filter((row) => row.exitedAt === undefined)
			.map((row) => ({ key: String(row.pid), pid: row.pid, sessionId: row.bridge?.sessionId }));
	}

	setState(pid: number, state: SessionState): void {
		const row = this.rows.get(pid) ?? this.create(pid, state.sty);
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

	bye(pid: number, reason: string): void {
		const row = this.rows.get(pid);
		if (!row) return;
		row.connected = false;
		if (reason === "quit") {
			row.exitedAt = Date.now();
			row.exitReason = reason;
		}
		this.refreshStatus(row, Date.now());
		this.onChange();
	}

	disconnect(pid: number): void {
		const row = this.rows.get(pid);
		if (!row) return;
		row.connected = false;
		if (row.exitedAt === undefined && !pidAlive(pid)) row.exitedAt = Date.now();
		this.refreshStatus(row, Date.now());
		this.onChange();
	}

	incompatible(pid: number, version: number): void {
		const row = this.rows.get(pid) ?? this.create(pid, undefined);
		row.incompatibleVersion = version;
		this.onChange();
	}

	dismiss(pid: number): void {
		this.rows.delete(pid);
		this.onChange();
	}

	acknowledge(pid: number): void {
		const row = this.rows.get(pid);
		if (row) row.alertUntil = undefined;
	}

	applySample(sample: Sample, gpu: GpuSample | undefined, now: number): void {
		this.host = sample.host;
		this.gpu = gpu;
		this.hostCpu.push(sample.host.cpu);
		this.hostMem.push(sample.host.memTotal ? sample.host.memUsed / sample.host.memTotal : 0);
		this.gpuUtil.push(gpu?.utilization ?? Number.NaN);

		const live = new Map(sample.piProcesses.map((proc) => [proc.pid, proc]));
		for (const proc of live.values()) {
			const row = this.rows.get(proc.pid) ?? this.create(proc.pid, proc.sty);
			row.proc = proc;
		}
		for (const row of [...this.rows.values()]) {
			if (row.exitedAt !== undefined) continue;
			if (!row.bridge && !live.has(row.pid)) {
				// A pi without a bridge is only known through /proc.
				this.rows.delete(row.pid);
				continue;
			}
			if (row.bridge && !row.connected && !pidAlive(row.pid)) row.exitedAt = now;
		}
		for (const row of this.rows.values()) {
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

	private create(pid: number, sty: string | undefined): SessionRow {
		const name = screenName(sty);
		const pending = name ? this.pendingLaunches.get(name) : undefined;
		if (pending && name) {
			this.pendingLaunches.delete(name);
			if (pending.replacesPid !== undefined) this.rows.delete(pending.replacesPid);
		}
		const used = new Set([...this.rows.values()].map((row) => row.slot));
		let slot = pending?.slot !== undefined && !used.has(pending.slot) ? pending.slot : undefined;
		for (let candidate = 1; slot === undefined && candidate <= MAX_SLOTS; candidate++) {
			if (!used.has(candidate)) slot = candidate;
		}
		const row: SessionRow = {
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
		this.rows.set(pid, row);
		return row;
	}
}
