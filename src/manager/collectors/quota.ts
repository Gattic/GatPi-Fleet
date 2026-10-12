// Provider-reported quotas and local failover cooldowns are independent sources.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchProviderUsage, usageFamily, type QuotaWindow, type UsageCredential } from "./provider-usage.ts";

export interface QuotaReading { fetchedAt: number | null; windows: QuotaWindow[]; error?: string }
export interface QuotaAccount {
	provider: string;
	status: "fresh" | "stale" | "unknown" | "unsupported";
	fetchedAt: number | null;
	freshUntil: number | null;
	message: string | null;
	windows: QuotaWindow[];
}
interface Login { key: string; credential: UsageCredential; nextAt: number; pending?: Promise<void> }
const refreshMs = (provider: string) => usageFamily(provider) === "anthropic" ? 10 * 60_000 : 60_000;

export interface AccountCooldown {
	provider: string;
	until: number;
}

export function providerLabel(provider: string): string {
	return provider.replace(/^openai-/, "").replace(/-account-(\d+)$/, "#$1");
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class QuotaMonitor {
	/** null means the login list could not be read. */
	providers: string[] | null = null;
	/** null means cooldown state could not be read, not that all accounts are available. */
	cooldowns: AccountCooldown[] | null = null;
	private readonly file: string;
	private readonly authFile: string;
	readonly readings = new Map<string, QuotaReading>();
	private readonly logins = new Map<string, Login>();
	private readonly controller = new AbortController();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;

	constructor(file: string, authFile: string, options: { fetch?: typeof fetch; now?: () => number } = {}) {
		this.file = file;
		this.authFile = authFile;
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	/** No credential material, provider body, email or account ID crosses this boundary. */
	snapshot(now: number): QuotaAccount[] | null {
		return this.providers?.map((provider) => {
			const reading = this.readings.get(provider);
			const supported = usageFamily(provider) !== undefined;
			const fetchedAt = reading?.fetchedAt ?? null;
			const freshUntil = fetchedAt === null ? null : Math.min(fetchedAt + 2 * refreshMs(provider), ...reading!.windows.flatMap(({ resetAt }) => resetAt === null ? [] : [resetAt]));
			const error = reading?.error;
			const status = !supported ? "unsupported" : freshUntil === null ? "unknown" : error || now >= freshUntil ? "stale" : "fresh";
			return { provider, status, fetchedAt: reading?.fetchedAt ?? null, freshUntil,
				message: !supported ? "No supported quota endpoint" : error ?? (status === "stale" ? "Waiting for a fresh provider reading" : status === "unknown" ? "Waiting for provider usage" : null),
				windows: reading?.windows ?? [] };
		}) ?? null;
	}

	/** One in-flight GET per login; ordinary polling cannot bypass provider rate limits. */
	async refresh(): Promise<void> {
		if (this.controller.signal.aborted) return;
		this.poll();
		await Promise.all([...this.logins].map(async ([provider, login]) => {
			if (!usageFamily(provider)) return;
			if (login.pending) return login.pending;
			if (this.now() < login.nextAt) return;
			login.nextAt = this.now() + refreshMs(provider);
			login.pending = (async () => {
				try {
					const windows = await fetchProviderUsage(provider, login.credential, this.controller.signal, this.fetchImpl);
					// A removed/replaced login must never receive a late result from its predecessor.
					this.poll();
					if (this.controller.signal.aborted || this.logins.get(provider) !== login) return;
					const fetchedAt = this.now();
					this.readings.set(provider, { fetchedAt, windows });
					login.nextAt = Math.min(fetchedAt + refreshMs(provider), ...windows.flatMap(({ resetAt }) => resetAt !== null && resetAt > fetchedAt ? [resetAt] : []));
				} catch (error) {
					if (!this.controller.signal.aborted && this.logins.get(provider) === login) {
						const previous = this.readings.get(provider) ?? { fetchedAt: null, windows: [] };
						this.readings.set(provider, { ...previous, error: (error as Error).message });
					}
				} finally { login.pending = undefined; }
			})();
			return login.pending;
		}));
	}

	async close(): Promise<void> {
		this.controller.abort();
		await Promise.all([...this.logins.values()].map((login) => login.pending));
	}

	/** Expire against the caller's clock even when the state file has not changed. */
	activeCooldowns(now: number): AccountCooldown[] | null {
		const providers = this.providers;
		if (providers === null || this.cooldowns === null) return null;
		return this.cooldowns.filter(({ provider, until }) => providers.includes(provider) && until > now);
	}

	poll(): void {
		try {
			const auth: unknown = JSON.parse(readFileSync(this.authFile, "utf8"));
			if (!record(auth)) throw new Error("Invalid login state");
			this.providers = Object.keys(auth);
			for (const provider of this.logins.keys()) {
				if (!(provider in auth)) { this.logins.delete(provider); this.readings.delete(provider); }
			}
			for (const [provider, value] of Object.entries(auth)) {
				const key = createHash("sha256").update(JSON.stringify(value)).digest("hex");
				if (this.logins.get(provider)?.key === key) continue;
				this.logins.set(provider, { key, credential: record(value) ? value : {}, nextAt: 0 });
				this.readings.delete(provider);
			}
		} catch {
			this.providers = null;
			this.logins.clear(); this.readings.clear();
		}
		try {
			const state: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (!record(state) || !record(state.cooldowns)) throw new Error("Invalid multi-login state");
			this.cooldowns = Object.entries(state.cooldowns).map(([provider, until]) => {
				if (typeof until !== "number" || !Number.isFinite(until) || until < 0) throw new Error("Invalid cooldown timestamp");
				return { provider, until };
			});
		} catch (error) {
			// multi-login creates the file only after an account failure or an explicit reset.
			this.cooldowns = (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
		}
	}
}
