// NVIDIA GPU utilisation and per-process VRAM via nvidia-smi (absent → disabled).
import { execFile } from "node:child_process";

export interface GpuSample {
	utilization: number;
	memUsed: number;
	memTotal: number;
	/** Per-pid VRAM in bytes. */
	processes: Map<number, number>;
}

const MIB = 1024 * 1024;

function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("nvidia-smi", args, { timeout: 4000, encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

export function parseGpuQuery(deviceCsv: string, appsCsv: string): GpuSample {
	let utilization = 0;
	let memUsed = 0;
	let memTotal = 0;
	const devices = deviceCsv.trim().split("\n").filter(Boolean);
	for (const line of devices) {
		const [util, used, total] = line.split(",").map((part) => Number(part.trim()));
		utilization += Number.isFinite(util) ? util / 100 : 0;
		memUsed += (Number.isFinite(used) ? used : 0) * MIB;
		memTotal += (Number.isFinite(total) ? total : 0) * MIB;
	}
	const processes = new Map<number, number>();
	for (const line of appsCsv.trim().split("\n").filter(Boolean)) {
		const [pid, used] = line.split(",").map((part) => Number(part.trim()));
		if (Number.isFinite(pid) && Number.isFinite(used)) processes.set(pid, (processes.get(pid) ?? 0) + used * MIB);
	}
	return { utilization: devices.length ? utilization / devices.length : 0, memUsed, memTotal, processes };
}

export class GpuMonitor {
	latest?: GpuSample;
	available = true;
	private busy = false;

	async poll(): Promise<void> {
		if (!this.available || this.busy) return;
		this.busy = true;
		try {
			const [device, apps] = await Promise.all([
				run(["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]),
				run(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]),
			]);
			this.latest = parseGpuQuery(device, apps);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") this.available = false;
		} finally {
			this.busy = false;
		}
	}
}
