// Provider-reported quotas and local failover cooldowns are independent sources.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renewLoginWithPi, type RenewLogin } from "./oauth-renewal.ts";
import { assertUsageCredential, credentialExpired, fetchProviderUsage, REFRESH_REQUIRED, UsageCredentialError, UsageFetchError, usageFamily, type QuotaWindow, type UsageCredential } from "./provider-usage.ts";
import { SharedUsageState } from "./quota-state.ts";

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
const RENEW_RETRY_MS = 5 * 60_000;

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
	private readonly renewLogin: RenewLogin;
	/** Per provider, not per login: a replaced but still-expired login must not restart the spacing. */
	private readonly renewAt = new Map<string, number>();
	/** A started refresh may hold the only copy of a rotated refresh token, so close() outlives it. */
	private readonly renewing = new Map<string, Promise<void>>();
	private readonly shared: SharedUsageState;

	constructor(file: string, authFile: string, options: { fetch?: typeof fetch; now?: () => number; renew?: RenewLogin } = {}) {
		this.file = file;
		this.authFile = authFile;
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.renewLogin = options.renew ?? renewLoginWithPi;
		this.shared = new SharedUsageState(authFile);
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

	/** Anthropic reservations/readings survive controllers; Codex and xAI retain their local intervals. */
	async refresh(): Promise<void> {
		if (this.controller.signal.aborted) return;
		this.poll();
		await Promise.all([...this.logins].map(async ([provider, login]) => {
			const family = usageFamily(provider);
			if (!family) return;
			if (login.pending) return login.pending;
			const now = this.now();
			if (credentialExpired(login.credential, now)) {
				const renewal = this.renewing.get(provider);
				if (renewal) return renewal;
				if (now >= (this.renewAt.get(provider) ?? 0)) return this.startRenewal(provider, now);
				// Inside the retry spacing the expiry itself is diagnosed below.
			}
			try { assertUsageCredential(login.credential, now); }
			catch (error) {
				const previous = this.readings.get(provider) ?? { fetchedAt: null, windows: [] };
				this.readings.set(provider, { ...previous, error: (error as UsageFetchError).message });
				return;
			}
			let reservation: string | undefined;
			try {
				if (family === "anthropic") {
					const shared = this.shared.read(provider);
					if (shared?.credentialKey === login.key && shared.reading) this.readings.set(provider, shared.reading);
					if (now < Math.max(login.nextAt, shared?.nextAt ?? 0, shared?.pendingUntil ?? 0)) return;
					const claim = this.shared.claim(provider, login.key, now, refreshMs(provider));
					if (claim.state.credentialKey === login.key && claim.state.reading) this.readings.set(provider, claim.state.reading);
					if (!claim.claimed) return;
					reservation = claim.state.reservation;
				} else if (now < login.nextAt) return;
			} catch {
				// Never probe without coordinating: a broken shared store must not multiply requests.
				const previous = this.readings.get(provider) ?? { fetchedAt: null, windows: [] };
				this.readings.set(provider, { ...previous, error: "Shared usage state unavailable" });
				return;
			}
			login.nextAt = now + refreshMs(provider);
			login.pending = (async () => {
				let reading: QuotaReading;
				let localAuthFailure = false;
				let retryAt: number | undefined;
				try {
					const windows = await fetchProviderUsage(provider, login.credential, this.controller.signal, this.fetchImpl, this.now);
					const fetchedAt = this.now();
					reading = { fetchedAt, windows };
					login.nextAt = Math.min(fetchedAt + refreshMs(provider), ...windows.flatMap(({ resetAt }) => resetAt !== null && resetAt > fetchedAt ? [resetAt] : []));
				} catch (error) {
					const previous = this.readings.get(provider) ?? { fetchedAt: null, windows: [] };
					reading = { ...previous, error: (error as Error).message };
					localAuthFailure = error instanceof UsageCredentialError;
					retryAt = error instanceof UsageFetchError ? error.retryAt : undefined;
					if (localAuthFailure) login.nextAt = 0;
					else if (retryAt !== undefined) login.nextAt = Math.max(login.nextAt, retryAt);
				}
				if (reservation !== undefined) {
					try {
						if (localAuthFailure) this.shared.cancel(provider, reservation);
						else if (retryAt !== undefined) this.shared.backoff(provider, retryAt);
					} catch { reading = { ...reading, error: "Shared usage state unavailable" }; }
				}
				if (this.controller.signal.aborted) return;
				if (reservation !== undefined && !localAuthFailure) {
					try {
						if (!this.shared.complete(provider, reservation, login.nextAt, reading)) { login.nextAt = 0; return; }
					} catch { reading = { ...reading, error: "Shared usage state unavailable" }; }
				}
				// A removed/replaced login must never receive its predecessor's reading.
				// Its provider cooldown still applies, including after a token refresh.
				this.poll();
				if (this.logins.get(provider) === login) this.readings.set(provider, reading);
			})().finally(() => { login.pending = undefined; });
			return login.pending;
		}));
	}

	private startRenewal(provider: string, now: number): Promise<void> {
		this.renewAt.set(provider, now + RENEW_RETRY_MS);
		const renewal = this.renew(provider).finally(() => this.renewing.delete(provider));
		this.renewing.set(provider, renewal);
		return renewal;
	}

	/** Pi rewrites auth.json; poll() adopts the renewed login and the next refresh probes with it. */
	private async renew(provider: string): Promise<void> {
		try { await this.renewLogin(this.authFile, provider); }
		// Refresh failures can embed provider response bodies: report only that Pi must repair the login.
		catch { /* a login that is still expired is diagnosed below */ }
		if (this.controller.signal.aborted) return;
		this.poll();
		const login = this.logins.get(provider);
		if (!login || !credentialExpired(login.credential, this.now())) return;
		const previous = this.readings.get(provider) ?? { fetchedAt: null, windows: [] };
		this.readings.set(provider, { ...previous, error: REFRESH_REQUIRED });
	}

	/** Aborts usage requests only; a started renewal is never cancelled and is awaited so the process cannot exit mid-refresh. */
	async close(): Promise<void> {
		this.controller.abort();
		await Promise.all([...[...this.logins.values()].map((login) => login.pending), ...this.renewing.values()]);
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
