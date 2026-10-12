import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fetchProviderUsage, parseUsage } from "../src/manager/collectors/provider-usage.ts";
import { QuotaMonitor } from "../src/manager/collectors/quota.ts";

const NOW = Date.UTC(2026, 9, 12, 10);
const HOUR = 3_600_000;
const anthropic = { five_hour: { utilization: 25, resets_at: new Date(NOW + HOUR).toISOString() }, seven_day: { utilization: 57, resets_at: new Date(NOW + 3 * 86400_000).toISOString() } };
const codex = { rate_limit: { primary_window: { used_percent: 7, reset_at: (NOW + 86400_000) / 1000, limit_window_seconds: 30 * 86400 } } };
const credential = { type: "oauth", access: "secret-access", accountId: "private-account" };

test("provider windows preserve zero, percentages, actual duration, seconds and ISO reset times", () => {
	assert.deepEqual(parseUsage("anthropic", anthropic), [{ label: "5h", usedPercent: 25, resetAt: NOW + HOUR }, { label: "7d", usedPercent: 57, resetAt: NOW + 3 * 86400_000 }]);
	assert.deepEqual(parseUsage("codex", codex), [{ label: "30d", usedPercent: 7, resetAt: NOW + 86400_000 }]);
	assert.equal(parseUsage("anthropic", { five_hour: { utilization: 0, resets_at: NOW } })[0].usedPercent, 0);
	for (const bad of [null, {}, [], { five_hour: { utilization: -1, resets_at: NOW } }, { five_hour: { utilization: null, resets_at: NOW } }, { five_hour: { utilization: false, resets_at: NOW } }, { five_hour: { utilization: "", resets_at: NOW } }, { five_hour: { utilization: 0, resets_at: "bad" } }]) assert.deepEqual(parseUsage("anthropic", bad), []);
	assert.deepEqual(parseUsage("codex", { rate_limit: { allowed: true } }), [], "availability is not a balance");
});

test("only exact provider families send stored OAuth credentials to fixed origins without redirects", async () => {
	for (const [provider, host, body] of [["anthropic-account-2", "https://api.anthropic.com/api/oauth/usage", anthropic], ["openai-codex-account-2", "https://chatgpt.com/backend-api/wham/usage", codex]] as const) {
		let calls = 0;
		const windows = await fetchProviderUsage(provider, credential, new AbortController().signal, async (url, init) => {
			calls++;
			assert.equal(url, host); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("Authorization"), "Bearer secret-access");
			if (provider.startsWith("anthropic")) { assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20"); assert.equal(headers.get("ChatGPT-Account-Id"), null); }
			else assert.equal(headers.get("ChatGPT-Account-Id"), "private-account");
			return Response.json(body);
		});
		assert.equal(calls, 1);
		assert.doesNotMatch(JSON.stringify(windows), /secret|private-account/);
	}
	const unexpected: typeof fetch = async () => { throw new Error("must not fetch"); };
	await assert.rejects(fetchProviderUsage("openai", credential, new AbortController().signal, unexpected), /not supported/);
	await assert.rejects(fetchProviderUsage("anthropic-evil", credential, new AbortController().signal, unexpected), /not supported/);
	await assert.rejects(fetchProviderUsage("anthropic", { type: "api_key" }, new AbortController().signal, unexpected), /OAuth login required/);
});

test("quota failures are bounded and never expose raw bodies or errors", async () => {
	const request = (impl: typeof fetch) => fetchProviderUsage("anthropic", credential, new AbortController().signal, impl);
	await assert.rejects(request(async () => new Response("secret-access", { status: 401 })), { message: "HTTP 401: refresh login in Pi" });
	await assert.rejects(request(async () => { throw new Error("secret-access"); }), { message: "Usage request failed or timed out" });
	await assert.rejects(request(async () => new Response("not JSON secret-access")), { message: "Usage request failed or timed out" });
	await assert.rejects(request(async () => Response.json({})), /no quota windows/);
	await assert.rejects(request(async () => new Response("x".repeat(65537))), /too large/);
});

function monitor(t: TestContext, impl: typeof fetch) {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
	let now = NOW;
	const save = (value: unknown) => writeFileSync(join(dir, "auth.json"), JSON.stringify(value));
	save({ anthropic: credential, "openai-codex-account-2": credential, openai: credential });
	const quota = new QuotaMonitor(join(dir, "multi-login-state.json"), join(dir, "auth.json"), { fetch: impl, now: () => now });
	t.after(async () => { await quota.close(); rmSync(dir, { recursive: true, force: true }); });
	return { quota, save, tick: (ms: number) => { now += ms; }, snapshot: () => quota.snapshot(now)! };
}

test("all logins collect independently; polling is throttled, expiry and failures are visibly stale", async (t) => {
	const calls: string[] = [];
	let failCodex = false;
	const f = monitor(t, async (url) => {
		calls.push(String(url));
		return String(url).includes("anthropic") ? Response.json(anthropic) : failCodex ? new Response("", { status: 429 }) : Response.json(codex);
	});
	await f.quota.refresh();
	assert.deepEqual(f.snapshot().map((a) => a.status), ["fresh", "fresh", "unsupported"]);
	assert.deepEqual(f.snapshot().map((a) => a.provider), ["anthropic", "openai-codex-account-2", "openai"]);
	assert.equal(calls.length, 2);
	await f.quota.refresh(); assert.equal(calls.length, 2);
	f.tick(60_000); failCodex = true;
	await f.quota.refresh();
	assert.equal(calls.length, 3, "Anthropic respects the upstream ten-minute minimum");
	assert.equal(f.snapshot()[1].status, "stale");
	assert.equal(f.snapshot()[1].fetchedAt, NOW, "failed fetch cannot renew the timestamp");
	assert.equal(f.snapshot()[1].message, "Usage endpoint HTTP 429");
	assert.equal(f.snapshot()[0].status, "fresh");
	f.tick(20 * 60_000);
	assert.equal(f.snapshot()[0].status, "stale", "stale even if the poller stops");
	failCodex = false; await f.quota.refresh();
	assert.equal(f.snapshot()[1].status, "fresh");
	assert.equal(f.snapshot()[1].message, null, "successful refresh clears a previous error");
	assert.deepEqual(f.quota.activeCooldowns(NOW), [], "quota probes do not bench accounts");
	assert.doesNotMatch(JSON.stringify(f.snapshot()), /secret-access|private-account/);
});

test("a failed first fetch and non-OAuth login stay unknown without fabricated windows", async (t) => {
	let calls = 0;
	const f = monitor(t, async () => { calls++; return new Response("private-account", { status: 401 }); });
	f.save({ anthropic: { type: "api_key", key: "secret-key" }, "openai-codex": credential });
	await f.quota.refresh();
	assert.equal(calls, 1);
	assert.deepEqual(f.snapshot().map((a) => a.status), ["unknown", "unknown"]);
	assert.deepEqual(f.snapshot().map((a) => a.message), ["OAuth login required", "HTTP 401: refresh login in Pi"]);
	for (const account of f.snapshot()) { assert.equal(account.fetchedAt, null); assert.equal(account.freshUntil, null); assert.deepEqual(account.windows, []); }
	assert.doesNotMatch(JSON.stringify(f.snapshot()), /secret|private-account/);
});

test("reset expiry is not an invented refill, and a new provider reading restores freshness", async (t) => {
	let reset = NOW + 30_000;
	const f = monitor(t, async () => Response.json({ five_hour: { utilization: 100, resets_at: reset } }));
	f.save({ anthropic: credential });
	await f.quota.refresh(); f.tick(30_000);
	assert.equal(f.snapshot()[0].status, "stale");
	assert.equal(f.snapshot()[0].windows[0].usedPercent, 100);
	reset = NOW + HOUR;
	await f.quota.refresh();
	assert.equal(f.snapshot()[0].status, "fresh");
	assert.equal(f.snapshot()[0].fetchedAt, NOW + 30_000);
});

test("concurrent polls deduplicate, replaced/removed credentials reject in-flight results", async (t) => {
	let complete!: (response: Response) => void;
	let calls = 0;
	const f = monitor(t, () => { calls++; return new Promise<Response>((resolve) => { complete = resolve; }); });
	f.save({ anthropic: credential });
	const first = f.quota.refresh(); const second = f.quota.refresh();
	assert.equal(calls, 1);
	f.save({ anthropic: { ...credential, access: "replacement-secret" } });
	complete(Response.json(anthropic)); await Promise.all([first, second]);
	assert.equal(f.snapshot()[0].status, "unknown", "old account result discarded even without another explicit poll");
	const next = f.quota.refresh(); complete(Response.json(anthropic)); await next;
	assert.equal(f.snapshot()[0].status, "fresh");
	f.save({}); f.quota.poll(); assert.deepEqual(f.snapshot(), []);
	f.save(null); f.quota.poll(); assert.equal(f.quota.snapshot(NOW), null);
});

test("close cancels the outstanding request without publishing a result", async (t) => {
	let signal: AbortSignal | undefined;
	const f = monitor(t, async (_url, init) => {
		signal = init!.signal!;
		return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
	});
	f.save({ anthropic: credential });
	const pending = f.quota.refresh();
	await f.quota.close(); await pending;
	assert.equal(signal?.aborted, true);
	assert.equal(f.snapshot()[0].fetchedAt, null);
});
