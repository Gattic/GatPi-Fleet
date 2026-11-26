// Anthropic/Codex/xAI usage readers adapted from Sarrius/pi-multi-account (MIT).
// Pinned source and license: docs/THIRD-PARTY-NOTICES.md. No routing; this adapter never mutates auth.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** null resetAt preserves a reported balance when the provider has no reset timestamp. */
export interface QuotaWindow { label: string; usedPercent: number; resetAt: number | null }
export interface UsageCredential { type?: unknown; access?: unknown; accountId?: unknown; expires?: unknown }
export type UsageFamily = "anthropic" | "codex" | "xai" | "antigravity";

export function usageFamily(provider: string): UsageFamily | undefined {
	if (/^anthropic(?:-account-\d+)?$/.test(provider)) return "anthropic";
	if (/^openai-codex(?:-account-\d+)?$/.test(provider)) return "codex";
	if (/^xai(?:-account-\d+)?$/.test(provider)) return "xai";
	if (provider === "google-antigravity-acp") return "antigravity";
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
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** A model scope names the pool beside the duration, so a separate Fable week is not read as the all-model week. */
function window(value: unknown, seconds: number, scope?: string): QuotaWindow | undefined {
	const source = record(value);
	const percent = number(source.used_percent ?? source.utilization);
	const resetValue = "reset_at" in source ? source.reset_at : source.resets_at;
	const resetAt = resetValue === null ? null : epoch(resetValue);
	if (percent === undefined || percent < 0 || resetAt === undefined) return undefined;
	const duration = number(source.limit_window_seconds) ?? seconds;
	if (duration <= 0) return undefined;
	const label = scope === undefined ? durationLabel(duration) : `${durationLabel(duration)} ${scope}`;
	return { label, usedPercent: Math.min(100, percent), resetAt };
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

/** Provider scopes become labels; a name is slugged so it cannot break the shared-state label grammar. */
function scopeLabel(value: unknown): string | undefined {
	const name = text(value);
	if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) return undefined;
	const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40);
	return slug || undefined;
}

/** Anthropic reports scoped weekly pools in `limits`; the all-model week stays `seven_day`. */
function anthropicScopedWindows(source: Record<string, unknown>): QuotaWindow[] {
	if (!Array.isArray(source.limits)) return [];
	const windows: QuotaWindow[] = [];
	const seen = new Set<string>();
	for (const value of source.limits) {
		const limit = record(value);
		if (limit.kind !== "weekly_scoped" || limit.group !== "weekly") continue;
		const scope = scopeLabel(record(record(limit.scope).model).display_name);
		if (!scope || seen.has(scope)) continue;
		const percent = number(limit.percent);
		const resetAt = limit.resets_at === null ? null : epoch(limit.resets_at);
		if (percent === undefined || percent < 0 || resetAt === undefined) continue;
		seen.add(scope);
		windows.push({ label: `7d ${scope}`, usedPercent: Math.min(100, percent), resetAt });
	}
	return windows;
}

/** Missing/malformed windows stay unknown; an HTTP success alone is not quota data. */
export function parseUsage(family: UsageFamily, body: unknown, now = Date.now()): QuotaWindow[] {
	const source = record(body);
	if (family === "xai") {
		const reading = xaiWindow(source, now);
		return reading ? [reading] : [];
	}
	if (family === "antigravity") return antigravityWindows(source);
	const limits = record(source.rate_limit);
	const windows = [
		window(family === "anthropic" ? source.five_hour : limits.primary_window, 5 * 3600),
		window(family === "anthropic" ? source.seven_day : limits.secondary_window, 7 * 86400),
	];
	if (family === "anthropic") windows.push(...anthropicScopedWindows(source));
	return windows.filter((entry): entry is QuotaWindow => entry !== undefined);
}

/**
 * The quota summary groups the models that share one weekly pool and one five-hour smoothing pool.
 * Both pools are shown; the per-model buckets say nothing beyond them.
 */
function antigravityWindows(body: Record<string, unknown>): QuotaWindow[] {
	const groups = body.groups;
	if (!Array.isArray(groups)) return [];
	const pools: { scope: string | undefined; windows: QuotaWindow[] }[] = [];
	const seen = new Set<string>();
	for (const value of groups) {
		const group = record(value);
		if (!Array.isArray(group.buckets)) continue;
		const buckets = group.buckets.map(record);
		const windows: QuotaWindow[] = [];
		for (const [kind, label] of [["5h", "5h"], ["weekly", "7d"]] as const) {
			const bucket = buckets.find((entry) => entry.window === kind);
			if (!bucket) continue;
			const remaining = number(bucket.remainingFraction);
			const resetAt = bucket.resetTime === undefined || bucket.resetTime === null ? null : epoch(bucket.resetTime);
			if (remaining === undefined || remaining < 0 || remaining > 1 || resetAt === undefined) continue;
			windows.push({ label, usedPercent: Math.round((1 - remaining) * 100), resetAt });
		}
		if (!windows.length) continue;
		const scope = scopeLabel(group.displayName);
		if (scope !== undefined) {
			if (seen.has(scope)) continue;
			seen.add(scope);
		}
		pools.push({ scope, windows });
	}
	if (!pools.length) return [];
	// One pool is the account's only group; several groups need their name beside each duration.
	if (pools.length === 1) return pools[0].windows;
	return pools.flatMap(({ scope, windows }) => scope === undefined ? [] : windows.map((window) => ({ ...window, label: `${window.label} ${scope}` })));
}

export class UsageFetchError extends Error {
	readonly retryAt: number | undefined;
	constructor(message: string, retryAt?: number) { super(message); this.retryAt = retryAt; }
}

/** A local rejection proves that no provider request was attempted. */
export class UsageCredentialError extends UsageFetchError {}

export const REFRESH_REQUIRED = "OAuth refresh required in Pi";

/**
 * Google Antigravity's ACP login belongs to its own server: Pi stores only a marker in auth.json, and the
 * server keeps the refresh token at ~/.gemini/antigravity-acp/acp_token.json. A quota read therefore
 * exchanges that refresh token at Google's fixed token endpoint for a short-lived access token. Nothing is
 * persisted here, and the server's token file is never written.
 */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_QUOTA_ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.googleapis.com",
];
const ANTIGRAVITY_CLIENT_METADATA = { ideType: "ANTIGRAVITY", platform: "DARWIN_ARM64", pluginType: "CLOUD_CODE", ideName: "antigravity" };

export function resolveAcpTokenFile(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.HOME?.trim() || homedir();
	const geminiHome = env.GEMINI_HOME?.trim();
	const base = geminiHome === undefined || geminiHome === "" ? join(home, ".gemini")
		: geminiHome === "~" || geminiHome.startsWith("~/") ? join(home, geminiHome.slice(1)) : geminiHome;
	return join(base, "antigravity-acp", "acp_token.json");
}

/** A local rejection (missing or incomplete token file) proves that no provider request was attempted. */
class AcpTokenError extends Error {
	readonly local: boolean;
	constructor(message: string, local: boolean) { super(message); this.local = local; }
}

/** The client the login was issued to; the host platform stays truthful rather than claiming the IDE's. */
function antigravityUserAgent(): string {
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION?.trim() || "1.107.0";
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
	return `antigravity/${version} ${platform}/${process.arch}`;
}

interface AcpAccessToken { access: string; projectId: string }

/** Reads the ACP server's login and resolves one access token; the refresh token is never stored by us. */
async function acpAccessToken(file: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<AcpAccessToken> {
	let stored: Record<string, unknown>;
	try { stored = record(JSON.parse(readFileSync(file, "utf8"))); }
	catch (error) {
		throw new AcpTokenError((error as NodeJS.ErrnoException).code === "ENOENT" ? "ACP login not found" : "ACP token file is unreadable", true);
	}
	const clientId = text(stored.client_id);
	const clientSecret = text(stored.client_secret);
	const refreshToken = text(stored.refresh_token);
	const projectId = text(stored.project_id);
	if (!clientId || !clientSecret || !refreshToken || !projectId) throw new AcpTokenError("ACP token file is incomplete", true);
	// The endpoint comes from a local file; only Google's own token endpoint may receive the client secret.
	if (stored.token_uri !== GOOGLE_TOKEN_URL) throw new AcpTokenError("ACP token file has an unsupported token endpoint", true);
	let response: Response;
	try {
		response = await fetchImpl(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString(),
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
		});
	} catch { throw new AcpTokenError("ACP token request failed or timed out", false); }
	if (!response.ok) {
		try { await response.body?.cancel(); }
		catch { /* the HTTP status stays authoritative */ }
		const rejected = response.status === 400 || response.status === 401 || response.status === 403;
		throw new AcpTokenError(rejected ? "ACP login needs re-authentication" : `ACP token endpoint HTTP ${response.status}`, false);
	}
	let body: unknown;
	try { body = await readJson(response, "ACP token response"); }
	catch { throw new AcpTokenError("ACP token request failed or timed out", false); }
	const access = text(record(body).access_token);
	if (!access) throw new AcpTokenError("ACP token response has no access token", false);
	return { access, projectId };
}

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
	const header = value.trim();
	const at = /^\d+$/.test(header) ? now + Number(header) * 1000
		: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header) ? Date.parse(header) : NaN;
	return Number.isSafeInteger(at) && at > now && at <= 8_640_000_000_000_000 ? at : undefined;
}

/** Bounded body read; a provider body never reaches a caller unbounded. */
async function readJson(response: Response, label: string): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new UsageFetchError(`${label} is empty`);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 64 * 1024) { await reader.cancel(); throw new UsageFetchError(`${label} too large`); }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

interface UsageRequest { method: "GET" | "POST"; endpoints: string[]; headers: Record<string, string>; body?: string }

/** Fixed HTTPS destinations, no redirects, ten-second bound per attempt; only a gated client falls through. */
async function sendUsageRequest(request: UsageRequest, signal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
	let failure: unknown;
	for (const [index, endpoint] of request.endpoints.entries()) {
		try {
			const response = await fetchImpl(endpoint, {
				method: request.method,
				headers: request.headers,
				...(request.body === undefined ? {} : { body: request.body }),
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
			});
			// Antigravity answers 403/404 on an endpoint that does not serve this client; the last answer stands.
			if (index < request.endpoints.length - 1 && (response.status === 403 || response.status === 404)) {
				try { await response.body?.cancel(); }
				catch { /* the endpoint choice must not depend on body cleanup */ }
				continue;
			}
			return response;
		} catch (error) {
			if (signal.aborted) throw error;
			failure = error;
		}
	}
	throw failure ?? new UsageFetchError("Usage endpoint unavailable");
}

/** The only credential-bearing boundary: fixed HTTPS requests, no redirects, bodies or raw errors exposed. */
export async function fetchProviderUsage(provider: string, credential: UsageCredential, signal: AbortSignal, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, acpTokenFile: string = resolveAcpTokenFile()): Promise<QuotaWindow[]> {
	const family = usageFamily(provider);
	if (!family) throw new UsageFetchError("Quota endpoint not supported");
	let request: UsageRequest;
	if (family === "antigravity") {
		let token: AcpAccessToken;
		try { token = await acpAccessToken(acpTokenFile, fetchImpl, signal); }
		catch (error) {
			if (!(error instanceof AcpTokenError)) throw new UsageFetchError("Usage request failed or timed out");
			throw error.local ? new UsageCredentialError(error.message) : new UsageFetchError(error.message);
		}
		request = {
			method: "POST",
			endpoints: ANTIGRAVITY_QUOTA_ENDPOINTS.map((endpoint) => `${endpoint}/v1internal:retrieveUserQuotaSummary`),
			headers: { Authorization: `Bearer ${token.access}`, Accept: "application/json", "Content-Type": "application/json", "User-Agent": antigravityUserAgent(), "Client-Metadata": JSON.stringify(ANTIGRAVITY_CLIENT_METADATA) },
			body: JSON.stringify({ project: token.projectId }),
		};
	} else {
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
		request = { method: "GET", endpoints: [url], headers };
	}
	try {
		const response = await sendUsageRequest(request, signal, fetchImpl);
		if (!response.ok) {
			const retryAt = retryAfter(response.headers.get("Retry-After"), now());
			// "refresh login in Pi" is Pi's own login repair; an Antigravity ACP login is repaired by its server.
			const unauthorized = family !== "antigravity" && (response.status === 401 || response.status === 403);
			const failure = new UsageFetchError(unauthorized ? `HTTP ${response.status}: refresh login in Pi` : `Usage endpoint HTTP ${response.status}`, retryAt);
			// Discarding the body must not replace the authoritative HTTP failure/cooldown.
			try { await response.body?.cancel(); }
			catch { throw failure; }
			throw failure;
		}
		const fetchedAt = now();
		const body = await readJson(response, "Usage response");
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
