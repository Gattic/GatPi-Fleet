import { createHash } from "node:crypto";
import { UncertainCommandError } from "../manager/collectors/bridges.ts";
import { ApiError } from "./contract.ts";

export interface Receipt {
	requestId: string;
	state: "received" | "accepted" | "failed" | "unknown";
	at: number;
	error?: string;
}
interface Entry { receipt: Receipt; fingerprint: string }
function canonical(value: unknown): string {
	if (value && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, JSON.parse(canonical(v))])));
	return JSON.stringify(value);
}

/** No durable replay. A restarted server has a new epoch and unknown old receipts. */
export class Receipts {
	private readonly devices = new Map<string, Map<string, Entry>>();
	private readonly changed: (device: string, receipt: Receipt) => void;
	constructor(changed: (device: string, receipt: Receipt) => void) { this.changed = changed; }
	get(device: string, requestId: string): Receipt | undefined { this.prune(); return this.devices.get(device)?.get(requestId)?.receipt; }
	prune(): void {
		for (const [device, entries] of this.devices) {
			for (const [id, entry] of entries) if (entry.receipt.state !== "received" && Date.now() - entry.receipt.at > 86_400_000) entries.delete(id);
			if (!entries.size) this.devices.delete(device);
		}
	}
	submit(device: string, requestId: string, body: unknown, action: () => Promise<unknown>): Receipt {
		this.prune();
		const entries = this.devices.get(device) ?? new Map<string, Entry>();
		const fingerprint = createHash("sha256").update(canonical(body)).digest("hex");
		const old = entries.get(requestId);
		if (old) {
			if (old.fingerprint !== fingerprint) throw new ApiError(409, "Request ID already used for different content");
			return old.receipt;
		}
		if (entries.size >= 1000) throw new ApiError(429, "Device receipt limit reached; wait for retention expiry");
		this.devices.set(device, entries);
		const receipt: Receipt = { requestId, state: "received", at: Date.now() };
		entries.set(requestId, { receipt, fingerprint });
		void Promise.resolve().then(action).then(
			() => { receipt.state = "accepted"; },
			(error: unknown) => {
				receipt.state = error instanceof UncertainCommandError ? "unknown" : "failed";
				receipt.error = error instanceof Error ? error.message.slice(0, 500) : "Command failed";
			},
		).finally(() => this.changed(device, receipt));
		return receipt;
	}
}
