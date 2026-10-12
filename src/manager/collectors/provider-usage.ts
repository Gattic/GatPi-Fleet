// Anthropic/Codex usage readers adapted from Sarrius/pi-multi-account (MIT).
// Pinned source and license: docs/THIRD-PARTY-NOTICES.md. No routing or auth mutation.
/** null resetAt preserves a reported balance when the provider has no reset timestamp. */
export interface QuotaWindow { label: string; usedPercent: number; resetAt: number | null }
export interface UsageCredential { type?: unknown; access?: unknown; accountId?: unknown; expires?: unknown }
export type UsageFamily = "anthropic" | "codex";

export function usageFamily(provider: string): UsageFamily | undefined {
	if (/^anthropic(?:-account-\d+)?$/.test(provider)) return "anthropic";
	if (/^openai-codex(?:-account-\d+)?$/.test(provider)) return "codex";
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
function window(value: unknown, seconds: number): QuotaWindow | undefined {
	const source = record(value);
	const percent = number(source.used_percent ?? source.utilization);
	const resetValue = "reset_at" in source ? source.reset_at : source.resets_at;
	const resetAt = resetValue === null ? null : epoch(resetValue);
	if (percent === undefined || percent < 0 || resetAt === undefined) return undefined;
	const duration = number(source.limit_window_seconds) ?? seconds;
	if (duration <= 0) return undefined;
	const label = duration >= 86400 ? `${Math.round(duration / 86400)}d` : duration >= 3600 ? `${Math.round(duration / 3600)}h` : `${Math.ceil(duration / 60)}m`;
	return { label, usedPercent: Math.min(100, percent), resetAt };
}

/** Missing/malformed windows stay unknown; an HTTP success alone is not quota data. */
export function parseUsage(family: UsageFamily, body: unknown): QuotaWindow[] {
	const source = record(body);
	const limits = record(source.rate_limit);
	return [
		window(family === "anthropic" ? source.five_hour : limits.primary_window, 5 * 3600),
		window(family === "anthropic" ? source.seven_day : limits.secondary_window, 7 * 86400),
	].filter((entry): entry is QuotaWindow => entry !== undefined);
}

export class UsageFetchError extends Error {}

/** The only credential-bearing boundary: fixed HTTPS GETs, no redirects, bodies or raw errors exposed. */
export async function fetchProviderUsage(provider: string, credential: UsageCredential, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<QuotaWindow[]> {
	const family = usageFamily(provider);
	if (!family) throw new UsageFetchError("Quota endpoint not supported");
	if (credential.type !== "oauth" || typeof credential.access !== "string" || !credential.access) throw new UsageFetchError("OAuth login required");
	const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}`, Accept: "application/json" };
	const url = family === "codex" ? "https://chatgpt.com/backend-api/wham/usage" : "https://api.anthropic.com/api/oauth/usage";
	if (family === "anthropic") headers["anthropic-beta"] = "oauth-2025-04-20";
	else if (typeof credential.accountId === "string" && credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
	try {
		const response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new UsageFetchError(response.status === 401 || response.status === 403 ? `HTTP ${response.status}: refresh login in Pi` : `Usage endpoint HTTP ${response.status}`);
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
		const windows = parseUsage(family, JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (!windows.length) throw new UsageFetchError("Provider returned no quota windows");
		return windows;
	} catch (error) {
		if (error instanceof UsageFetchError) throw error;
		// Network errors and response bodies can contain credentials or account identities.
		throw new UsageFetchError("Usage request failed or timed out");
	}
}
