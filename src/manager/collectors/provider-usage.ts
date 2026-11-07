// Anthropic/Codex/xAI usage readers adapted from Sarrius/pi-multi-account (MIT).
// Pinned source and license: docs/THIRD-PARTY-NOTICES.md. No routing; this adapter never mutates auth.
import { readFileSync } from "node:fs";
/** null resetAt preserves a reported balance when the provider has no reset timestamp. */
export interface QuotaWindow { label: string; usedPercent: number; resetAt: number | null }
export interface UsageCredential { type?: unknown; access?: unknown; accountId?: unknown; expires?: unknown }
export type UsageFamily = "anthropic" | "codex" | "xai";

export function usageFamily(provider: string): UsageFamily | undefined {
	if (/^anthropic(?:-account-\d+)?$/.test(provider)) return "anthropic";
	if (/^openai-codex(?:-account-\d+)?$/.test(provider)) return "codex";
	if (/^xai(?:-account-\d+)?$/.test(provider)) return "xai";
	return undefined;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | undefined {
	if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
	const result = Number(value);
	return Number.isFinite(result) ? result : undefined;
}
function epoch(value: unknown): number | undefined {
	const numeric = number(value);
	if (numeric !== undefined) return numeric > 0 ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : undefined;
	const parsed = typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function durationLabel(seconds: number): string {
	return seconds >= 86400 ? `${Math.round(seconds / 86400)}d` : seconds >= 3600 ? `${Math.round(seconds / 3600)}h` : `${Math.ceil(seconds / 60)}m`;
}
function window(value: unknown, seconds: number): QuotaWindow | undefined {
	const source = record(value);
	const percent = number(source.used_percent ?? source.utilization);
	const resetValue = "reset_at" in source ? source.reset_at : source.resets_at;
	const resetAt = resetValue === null ? null : epoch(resetValue);
	if (percent === undefined || percent < 0 || resetAt === undefined) return undefined;
	const duration = number(source.limit_window_seconds) ?? seconds;
	if (duration <= 0) return undefined;
	return { label: durationLabel(duration), usedPercent: Math.min(100, percent), resetAt };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return record(parsed);
	} catch { return undefined; }
}

/** xAI billing requires the authenticated user id in `x-userid`; it comes from the access-token JWT. */
export function xaiUserIdFromAccessToken(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const sub = payload?.sub;
	if (typeof sub === "string" && sub.trim()) return sub.trim();
	const principal = payload?.principal_id;
	return typeof principal === "string" && principal.trim() ? principal.trim() : undefined;
}

let xaiVersion: string | undefined;
/** A truthful host id, never an impersonated Grok CLI version. */
function xaiClientVersion(): string {
	if (xaiVersion) return xaiVersion;
	try {
		const pkg = record(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")));
		const name = typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "pi-dash";
		const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : undefined;
		xaiVersion = version ? `${name}/${version}` : name;
	} catch { xaiVersion = "pi-dash"; }
	return xaiVersion;
}

function xaiBuildPercent(value: unknown): number | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) {
		const product = record(item);
		if (typeof product.product !== "string") continue;
		const name = product.product.trim().toLowerCase().replace(/[_-]/g, "");
		if (name !== "productgrokbuild" && name !== "grokbuild") continue;
		const percent = number(product.usagePercent);
		if (percent !== undefined && percent >= 0) return Math.min(100, percent);
	}
	return undefined;
}

function xaiPeriod(value: unknown, fetchedAt: number): { resetAt: number; seconds: number } | undefined {
	const source = record(value);
	const start = epoch(source.start);
	const end = epoch(source.end);
	if (start === undefined || end === undefined || end <= start || fetchedAt < start || fetchedAt >= end) return undefined;
	const seconds = Math.round((end - start) / 1000);
	return seconds > 0 ? { resetAt: end, seconds } : undefined;
}

/** The reported period and whether it uses the current-period or legacy monthly fields. */
function xaiReportedPeriod(body: unknown, fetchedAt: number): { resetAt: number; seconds: number; modern: boolean } | undefined {
	const config = record(record(body).config);
	const modern = config.currentPeriod !== undefined;
	const period = modern
		? xaiPeriod(config.currentPeriod, fetchedAt)
		: xaiPeriod({ start: config.billingPeriodStart, end: config.billingPeriodEnd }, fetchedAt);
	return period === undefined ? undefined : { ...period, modern };
}

/** A period alone is not evidence of unused quota; missing percentages stay unknown. */
function xaiWindow(body: unknown, fetchedAt: number): QuotaWindow | undefined {
	const config = record(record(body).config);
	const period = xaiReportedPeriod(body, fetchedAt);
	if (period === undefined) return undefined;
	let usedPercent: number | undefined;
	if (period.modern) {
		usedPercent = number(config.creditUsagePercent) ?? xaiBuildPercent(config.productUsage);
	} else {
		const limit = number(record(config.monthlyLimit).val);
		const used = number(record(config.used).val);
		if (limit !== undefined && limit > 0 && used !== undefined && used >= 0) usedPercent = (used / limit) * 100;
	}
	if (usedPercent === undefined || usedPercent < 0) return undefined;
	return { label: durationLabel(period.seconds), usedPercent: Math.min(100, usedPercent), resetAt: period.resetAt };
}

/** A reported period without a percentage still has a useful reset time; do not invent usage. */
function xaiPeriodDiagnostic(body: unknown, fetchedAt: number): string | undefined {
	const period = xaiReportedPeriod(body, fetchedAt);
	if (period === undefined) return undefined;
	const kind = period.seconds >= 28 * 86400 ? "monthly" : period.seconds >= 6 * 86400 ? "weekly" : durationLabel(period.seconds);
	const reset = new Date(period.resetAt).toISOString().slice(0, 16).replace("T", " ");
	return `${kind} reset ${reset} UTC · usage % not reported`;
}

/** Missing/malformed windows stay unknown; an HTTP success alone is not quota data. */
export function parseUsage(family: UsageFamily, body: unknown, now = Date.now()): QuotaWindow[] {
	const source = record(body);
	if (family === "xai") {
		const reading = xaiWindow(source, now);
		return reading ? [reading] : [];
	}
	const limits = record(source.rate_limit);
	return [
		window(family === "anthropic" ? source.five_hour : limits.primary_window, 5 * 3600),
		window(family === "anthropic" ? source.seven_day : limits.secondary_window, 7 * 86400),
	].filter((entry): entry is QuotaWindow => entry !== undefined);
}

export class UsageFetchError extends Error {
	readonly retryAt: number | undefined;
	constructor(message: string, retryAt?: number) { super(message); this.retryAt = retryAt; }
}

/** A local rejection proves that no provider request was attempted. */
export class UsageCredentialError extends UsageFetchError {}

export const REFRESH_REQUIRED = "OAuth refresh required in Pi";

/** A known stored OAuth expiry at or before `now`; Pi's refresh (oauth-renewal.ts) is the only repair. */
export function credentialExpired(credential: UsageCredential, now: number): boolean {
	return credential.type === "oauth" && typeof credential.expires === "number" && credential.expires <= now;
}

/** Local auth failures must not consume a provider poll reservation. */
export function assertUsageCredential(credential: UsageCredential, now: number): asserts credential is UsageCredential & { type: "oauth"; access: string } {
	if (credential.type !== "oauth" || typeof credential.access !== "string" || !credential.access) throw new UsageCredentialError("OAuth login required");
	if (credentialExpired(credential, now)) throw new UsageCredentialError(REFRESH_REQUIRED);
}

function retryAfter(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const text = value.trim();
	const at = /^\d+$/.test(text) ? now + Number(text) * 1000
		: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) ? Date.parse(text) : NaN;
	return Number.isSafeInteger(at) && at > now && at <= 8_640_000_000_000_000 ? at : undefined;
}

/** The only credential-bearing boundary: fixed HTTPS GETs, no redirects, bodies or raw errors exposed. */
export async function fetchProviderUsage(provider: string, credential: UsageCredential, signal: AbortSignal, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<QuotaWindow[]> {
	const family = usageFamily(provider);
	if (!family) throw new UsageFetchError("Quota endpoint not supported");
	assertUsageCredential(credential, now());
	const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}`, Accept: "application/json" };
	let url: string;
	if (family === "anthropic") {
		url = "https://api.anthropic.com/api/oauth/usage";
		headers["anthropic-beta"] = "oauth-2025-04-20";
	} else if (family === "codex") {
		url = "https://chatgpt.com/backend-api/wham/usage";
		if (typeof credential.accountId === "string" && credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
	} else {
		const userId = xaiUserIdFromAccessToken(credential.access);
		if (!userId) throw new UsageFetchError("xAI access token has no user id");
		url = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
		headers["X-XAI-Token-Auth"] = "xai-grok-cli";
		headers["x-userid"] = userId;
		headers["x-grok-client-version"] = xaiClientVersion();
		headers["x-grok-client-mode"] = "headless";
	}
	try {
		const response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
		if (!response.ok) {
			const retryAt = retryAfter(response.headers.get("Retry-After"), now());
			const failure = new UsageFetchError(response.status === 401 || response.status === 403 ? `HTTP ${response.status}: refresh login in Pi` : `Usage endpoint HTTP ${response.status}`, retryAt);
			// Discarding the body must not replace the authoritative HTTP failure/cooldown.
			try { await response.body?.cancel(); }
			catch { throw failure; }
			throw failure;
		}
		const reader = response.body?.getReader();
		if (!reader) throw new UsageFetchError("Usage response is empty");
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 64 * 1024) { await reader.cancel(); throw new UsageFetchError("Usage response too large"); }
				chunks.push(value);
			}
		} finally { reader.releaseLock(); }
		const fetchedAt = now();
		const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const windows = parseUsage(family, body, fetchedAt);
		if (!windows.length) {
			if (family === "xai") {
				const diagnostic = xaiPeriodDiagnostic(body, fetchedAt);
				if (diagnostic) throw new UsageFetchError(diagnostic);
			}
			throw new UsageFetchError("Provider returned no quota windows");
		}
		return windows;
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		// Network errors and response bodies can contain credentials or account identities.
		throw new UsageFetchError("Usage request failed or timed out");
	}
}
