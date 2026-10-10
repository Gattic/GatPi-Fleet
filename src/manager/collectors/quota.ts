// Subscription quota windows recorded by pi's provider-failover state.
import { readFileSync, statSync } from "node:fs";

export interface QuotaWindow {
	/** Provider id as used in model keys, e.g. "anthropic", "openai-codex-account-2". */
	provider: string;
	/** Short display name, e.g. "codex#2". */
	providerLabel: string;
	/** Window label, e.g. "5h", "wk". */
	label: string;
	usedPercent: number;
	resetAt: number;
	windowSeconds: number;
	fetchedAt: number;
	exhaustedUntil?: number;
}

export function providerLabel(provider: string): string {
	return provider.replace(/^openai-/, "").replace(/-account-(\d+)$/, "#$1");
}

export function windowLabel(seconds: number): string {
	if (seconds === 604800) return "wk";
	if (seconds === 86400) return "day";
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return `${Math.round(seconds / 60)}m`;
}

interface FailoverState {
	usageByProvider?: Record<string, { fetchedAt?: number; primary?: RawWindow; secondary?: RawWindow }>;
	exhaustedUntilByProvider?: Record<string, number>;
}

interface RawWindow {
	usedPercent?: number;
	resetAt?: number;
	windowSeconds?: number;
}

/** Usage windows for the providers that still have a login; the failover state keeps removed accounts' last usage. */
export function parseQuota(raw: unknown, loggedIn: ReadonlySet<string>): QuotaWindow[] {
	const state = raw as FailoverState;
	const windows: QuotaWindow[] = [];
	for (const [provider, usage] of Object.entries(state.usageByProvider ?? {})) {
		if (!loggedIn.has(provider)) continue;
		for (const window of [usage.primary, usage.secondary]) {
			if (!window || typeof window.usedPercent !== "number" || typeof window.windowSeconds !== "number") continue;
			windows.push({
				provider,
				providerLabel: providerLabel(provider),
				label: windowLabel(window.windowSeconds),
				usedPercent: window.usedPercent,
				resetAt: window.resetAt ?? 0,
				windowSeconds: window.windowSeconds,
				fetchedAt: usage.fetchedAt ?? 0,
				exhaustedUntil: state.exhaustedUntilByProvider?.[provider],
			});
		}
	}
	return windows;
}

export class QuotaMonitor {
	windows: QuotaWindow[] = [];
	private stamp = "";
	private readonly file: string;
	private readonly authFile: string;

	constructor(file: string, authFile: string) {
		this.file = file;
		this.authFile = authFile;
	}

	poll(): void {
		try {
			const stamp = `${statSync(this.file).mtimeMs}:${statSync(this.authFile).mtimeMs}`;
			if (stamp === this.stamp) return;
			const auth = JSON.parse(readFileSync(this.authFile, "utf8")) as Record<string, unknown>;
			this.windows = parseQuota(JSON.parse(readFileSync(this.file, "utf8")), new Set(Object.keys(auth)));
			this.stamp = stamp;
		} catch {
			this.windows = [];
			this.stamp = "";
		}
	}
}
