import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { renewLoginWithPi, type RenewLogin } from "../src/manager/collectors/oauth-renewal.ts";
import { fetchProviderUsage, parseUsage, resolveAcpTokenFile, UsageFetchError, xaiUserIdFromAccessToken } from "../src/manager/collectors/provider-usage.ts";
import { QuotaMonitor } from "../src/manager/collectors/quota.ts";
import { SharedUsageState } from "../src/manager/collectors/quota-state.ts";

const NOW = Date.UTC(2026, 9, 12, 10);
const HOUR = 3_600_000;
const anthropic = { five_hour: { utilization: 25, resets_at: new Date(NOW + HOUR).toISOString() }, seven_day: { utilization: 57, resets_at: new Date(NOW + 3 * 86400_000).toISOString() } };
const codex = { rate_limit: { primary_window: { used_percent: 7, reset_at: (NOW + 86400_000) / 1000, limit_window_seconds: 30 * 86400 } } };
const credential = { type: "oauth", access: "secret-access", accountId: "private-account" };
const xaiAccess = `e30.${Buffer.from(JSON.stringify({ sub: "xai-user-private" })).toString("base64url")}.sig`;
const xaiCredential = { type: "oauth", access: xaiAccess };

test("provider windows preserve zero, percentages, actual duration, seconds and ISO reset times", () => {
	assert.deepEqual(parseUsage("anthropic", anthropic), [{ label: "5h", usedPercent: 25, resetAt: NOW + HOUR }, { label: "7d", usedPercent: 57, resetAt: NOW + 3 * 86400_000 }]);
	assert.deepEqual(parseUsage("codex", codex), [{ label: "30d", usedPercent: 7, resetAt: NOW + 86400_000 }]);
	assert.equal(parseUsage("anthropic", { five_hour: { utilization: 0, resets_at: NOW } })[0].usedPercent, 0);
	for (const bad of [null, {}, [], { five_hour: { utilization: -1, resets_at: NOW } }, { five_hour: { utilization: null, resets_at: NOW } }, { five_hour: { utilization: false, resets_at: NOW } }, { five_hour: { utilization: "", resets_at: NOW } }, { five_hour: { utilization: 0, resets_at: "bad" } }]) assert.deepEqual(parseUsage("anthropic", bad), []);
	assert.deepEqual(parseUsage("codex", { rate_limit: { allowed: true } }), [], "availability is not a balance");
});

test("Anthropic's idle five-hour balance survives a null reset without adding a Codex five-hour limit", () => {
	assert.deepEqual(parseUsage("anthropic", { ...anthropic, five_hour: { utilization: 0, resets_at: null } }), [
		{ label: "5h", usedPercent: 0, resetAt: null },
		{ label: "7d", usedPercent: 57, resetAt: NOW + 3 * 86400_000 },
	]);
	assert.deepEqual(parseUsage("codex", { rate_limit: { primary_window: { used_percent: 44, reset_at: (NOW + 86400_000) / 1000, limit_window_seconds: 7 * 86400 }, secondary_window: null } }), [
		{ label: "7d", usedPercent: 44, resetAt: NOW + 86400_000 },
	]);
	for (const resets_at of [undefined, "bad", false, 0]) {
		assert.deepEqual(parseUsage("anthropic", { five_hour: { utilization: 0, resets_at } }), [], "malformed resets are not explicit provider nulls");
	}
});

test("a balance without a reset still expires and respects the ordinary poll interval", async (t) => {
	let calls = 0;
	const f = monitor(t, async () => { calls++; return Response.json({ five_hour: { utilization: 0, resets_at: null } }); });
	f.save({ anthropic: credential });
	await f.quota.refresh();
	assert.equal(f.snapshot()[0].status, "fresh");
	assert.equal(f.snapshot()[0].freshUntil, NOW + 20 * 60_000);
	assert.deepEqual(f.snapshot()[0].windows, [{ label: "5h", usedPercent: 0, resetAt: null }]);
	f.tick(10 * 60_000 - 1); await f.quota.refresh();
	assert.equal(calls, 1, "no reset timestamp must not cause a hot polling loop");
	f.tick(1); await f.quota.refresh();
	assert.equal(calls, 2);
	assert.equal(f.snapshot()[0].freshUntil, NOW + 30 * 60_000);
	f.tick(20 * 60_000);
	assert.equal(f.snapshot()[0].status, "stale", "no reset timestamp must not mean indefinitely fresh");
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

test("xAI billing windows preserve the reported period and percentage, and a period alone stays unknown", () => {
	const weekly = { currentPeriod: { start: new Date(NOW).toISOString(), end: new Date(NOW + 7 * 86400_000).toISOString() } };
	const weeklyWindow = [{ label: "7d", usedPercent: 42, resetAt: NOW + 7 * 86400_000 }];
	assert.deepEqual(parseUsage("xai", { config: { ...weekly, creditUsagePercent: 42 } }, NOW), weeklyWindow);
	assert.deepEqual(parseUsage("xai", { config: { ...weekly, productUsage: [{ product: "product_grok_build", usagePercent: 55 }] } }, NOW), [
		{ label: "7d", usedPercent: 55, resetAt: NOW + 7 * 86400_000 },
	]);
	assert.deepEqual(parseUsage("xai", { config: weekly }, NOW), [], "a period alone is not evidence of unused quota");
	assert.deepEqual(parseUsage("xai", { config: { ...weekly, creditUsagePercent: "bad" } }, NOW), []);
	assert.deepEqual(parseUsage("xai", { config: { currentPeriod: { start: new Date(NOW + HOUR).toISOString(), end: new Date(NOW + 2 * HOUR).toISOString() }, creditUsagePercent: 10 } }, NOW), [], "a period that has not started is not current");
	const monthly = { billingPeriodStart: new Date(NOW).toISOString(), billingPeriodEnd: new Date(NOW + 30 * 86400_000).toISOString(), monthlyLimit: { val: 100 }, used: { val: 25 } };
	assert.deepEqual(parseUsage("xai", { config: monthly }, NOW), [{ label: "30d", usedPercent: 25, resetAt: NOW + 30 * 86400_000 }]);
	assert.deepEqual(parseUsage("xai", { config: { ...monthly, monthlyLimit: { val: 0 } } }, NOW), []);
	assert.deepEqual(parseUsage("xai", { config: { ...monthly, used: { val: "bad" } } }, NOW), []);
	assert.deepEqual(parseUsage("xai", null, NOW), []);
	assert.equal(parseUsage("xai", { config: { ...weekly, creditUsagePercent: 150 } }, NOW)[0].usedPercent, 100);
});

test("xAI probes the CLI billing endpoint with the JWT user id and sanitized failures", async () => {
	let calls = 0;
	const windows = await fetchProviderUsage("xai-account-2", xaiCredential, new AbortController().signal, async (url, init) => {
		calls++;
		assert.equal(url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("Authorization"), `Bearer ${xaiAccess}`);
		assert.equal(headers.get("X-XAI-Token-Auth"), "xai-grok-cli");
		assert.equal(headers.get("x-userid"), "xai-user-private");
		assert.equal(headers.get("x-grok-client-mode"), "headless");
		assert.match(headers.get("x-grok-client-version") ?? "", /^pi-dash(?:\/|$)/);
		assert.equal(headers.get("ChatGPT-Account-Id"), null);
		return Response.json({ config: { currentPeriod: { start: new Date(NOW).toISOString(), end: new Date(NOW + 7 * 86400_000).toISOString() }, creditUsagePercent: 12 } });
	}, () => NOW);
	assert.equal(calls, 1);
	assert.deepEqual(windows, [{ label: "7d", usedPercent: 12, resetAt: NOW + 7 * 86400_000 }]);
	assert.doesNotMatch(JSON.stringify(windows), /xai-user-private|secret/);
	assert.equal(xaiUserIdFromAccessToken(`e30.${Buffer.from(JSON.stringify({ principal_id: "xai-principal" })).toString("base64url")}.sig`), "xai-principal");
	assert.equal(xaiUserIdFromAccessToken("opaque-token"), undefined);
	const unexpected: typeof fetch = async () => { throw new Error("must not fetch"); };
	const noUser = `e30.${Buffer.from("{}").toString("base64url")}.sig`;
	await assert.rejects(fetchProviderUsage("xai", { type: "oauth", access: noUser }, new AbortController().signal, unexpected, () => NOW), { message: "xAI access token has no user id" });
	await assert.rejects(fetchProviderUsage("xai", { type: "api_key" }, new AbortController().signal, unexpected, () => NOW), /OAuth login required/);
	await assert.rejects(fetchProviderUsage("xai", xaiCredential, new AbortController().signal, async () => new Response("secret-access", { status: 401 }), () => NOW), { message: "HTTP 401: refresh login in Pi" });
	await assert.rejects(fetchProviderUsage("xai", xaiCredential, new AbortController().signal, async () => { throw new Error("secret-access"); }, () => NOW), { message: "Usage request failed or timed out" });
});

test("xAI polls independently each minute and a reset-bound reading is not renewed by age", async (t) => {
	let calls = 0;
	const period = { start: new Date(NOW - 60_000).toISOString(), end: new Date(NOW + 7 * 86400_000).toISOString() };
	const f = monitor(t, async (url) => {
		calls++;
		assert.equal(url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
		return Response.json({ config: { currentPeriod: period, creditUsagePercent: 12 } });
	});
	f.save({ xai: xaiCredential });
	await f.quota.refresh();
	assert.deepEqual(f.snapshot().map(({ provider, status }) => ({ provider, status })), [{ provider: "xai", status: "fresh" }]);
	assert.deepEqual(f.snapshot()[0].windows, [{ label: "7d", usedPercent: 12, resetAt: NOW + 7 * 86400_000 }]);
	assert.equal(calls, 1);
	await f.quota.refresh();
	assert.equal(calls, 1, "xAI respects its one-minute local interval");
	f.tick(60_000);
	await f.quota.refresh();
	assert.equal(calls, 2);
	assert.equal(f.snapshot()[0].status, "fresh");
	f.tick(120_000);
	assert.equal(f.snapshot()[0].status, "stale", "freshness ends before the provider reset");
	assert.equal(existsSync(join(f.dir, "pi-dash", "quota")), false, "xAI keeps a local interval, not shared Anthropic state");
});

test("xAI reports a period without a percentage as unknown with its reset time", async (t) => {
	const period = { start: new Date(NOW - 60_000).toISOString(), end: new Date(NOW + 7 * 86400_000).toISOString() };
	const f = monitor(t, async () => Response.json({ config: { currentPeriod: period } }));
	f.save({ xai: xaiCredential });
	await f.quota.refresh();
	const [account] = f.snapshot();
	assert.equal(account.status, "unknown");
	assert.deepEqual(account.windows, []);
	assert.equal(account.message, "weekly reset 2026-10-19 10:00 UTC · usage % not reported");
});

test("quota failures are bounded and never expose raw bodies or errors", async () => {
	const request = (impl: typeof fetch) => fetchProviderUsage("anthropic", credential, new AbortController().signal, impl);
	await assert.rejects(request(async () => new Response("secret-access", { status: 401 })), { message: "HTTP 401: refresh login in Pi" });
	await assert.rejects(request(async () => { throw new Error("secret-access"); }), { message: "Usage request failed or timed out" });
	await assert.rejects(request(async () => new Response("not JSON secret-access")), { message: "Usage request failed or timed out" });
	await assert.rejects(request(async () => Response.json({})), /no quota windows/);
	await assert.rejects(request(async () => new Response("x".repeat(65537))), /too large/);
});

/** The default renewer is Pi itself: a test must opt into any stand-in so none can reach a provider. */
function monitor(t: TestContext, impl: typeof fetch, clock?: () => number, renew: RenewLogin = async () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
	let now = NOW;
	const save = (value: unknown) => writeFileSync(join(dir, "auth.json"), JSON.stringify(value));
	save({ anthropic: credential, "openai-codex-account-2": credential, openai: credential });
	const monitors: QuotaMonitor[] = [];
	const newMonitor = () => {
		const quota = new QuotaMonitor(join(dir, "multi-login-state.json"), join(dir, "auth.json"), { fetch: impl, now: clock ?? (() => now), renew });
		monitors.push(quota);
		return quota;
	};
	const quota = newMonitor();
	t.after(async () => { await Promise.all(monitors.map((m) => m.close())); rmSync(dir, { recursive: true, force: true }); });
	return { dir, quota, newMonitor, save, tick: (ms: number) => { now += ms; }, snapshot: () => quota.snapshot(now)! };
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
	await f.quota.refresh();
	assert.equal(calls, 1, "credential changes cannot bypass the shared polling reservation");
	f.tick(10 * 60_000);
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

test("Retry-After supports delay seconds and HTTP dates without exposing response bodies", async () => {
	for (const [header, expected] of [
		["1640", NOW + 1640_000],
		[" 1640 ", NOW + 1640_000],
		[new Date(NOW + HOUR).toUTCString(), NOW + HOUR],
		[null, undefined], ["0", undefined], ["-1", undefined], ["1.5", undefined],
		["NaN", undefined], ["Infinity", undefined], ["9".repeat(100), undefined], ["tomorrow", undefined],
		[new Date(NOW - HOUR).toUTCString(), undefined],
	] as const) {
		await assert.rejects(fetchProviderUsage("anthropic", credential, new AbortController().signal,
			async () => new Response("secret-access private-account", { status: 429, headers: header === null ? {} : { "Retry-After": header } }), () => NOW), (error: unknown) => {
			assert.ok(error instanceof UsageFetchError);
			assert.equal(error.message, "Usage endpoint HTTP 429");
			assert.equal(error.retryAt, expected, `header: ${header}`);
			assert.doesNotMatch(JSON.stringify(error), /secret-access|private-account/);
			return true;
		});
	}
});

test("controllers share in-flight reservations and successful readings with private bounded state", async (t) => {
	let complete!: (response: Response) => void;
	let calls = 0;
	const f = monitor(t, async () => { calls++; return new Promise<Response>((resolve) => { complete = resolve; }); });
	f.save({ anthropic: credential });
	const peer = f.newMonitor();
	const pending = f.quota.refresh();
	await peer.refresh();
	assert.equal(calls, 1, "second controller cannot duplicate the pending request");
	complete(Response.json(anthropic)); await pending;
	await peer.refresh();
	assert.deepEqual(peer.snapshot(NOW), f.snapshot(), "the non-fetching controller receives the same reading");
	assert.equal(peer.snapshot(NOW)![0].status, "fresh");
	const restarted = f.newMonitor();
	await restarted.refresh();
	assert.equal(calls, 1, "a new controller cannot bypass the interval");
	assert.deepEqual(restarted.snapshot(NOW), f.snapshot());
	const dir = join(f.dir, "pi-dash", "quota");
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(dir).sort(), ["anthropic.json", "anthropic.json.lock"]);
	assert.equal(statSync(join(dir, "anthropic.json")).mode & 0o777, 0o600);
	assert.doesNotMatch(readFileSync(join(dir, "anthropic.json"), "utf8"), /secret-access|private-account|Authorization|Bearer/);
	f.tick(10 * 60_000);
	const next = f.quota.refresh();
	await peer.refresh();
	assert.equal(calls, 2, "one shared request per interval, not one per process");
	complete(Response.json(anthropic)); await next;
});

test("429 Retry-After survives restart even when response-body cleanup fails", async (t) => {
	let calls = 0;
	let throttled = false;
	const f = monitor(t, async () => {
		calls++;
		return throttled ? new Response(new ReadableStream({ cancel() { throw new Error("secret cleanup error"); } }),
			{ status: 429, headers: { "Retry-After": "1640" } }) : Response.json(anthropic);
	});
	f.save({ anthropic: credential });
	await f.quota.refresh();
	f.tick(10 * 60_000); throttled = true;
	await f.quota.refresh();
	const peer = f.newMonitor();
	await peer.refresh();
	assert.equal(calls, 2);
	assert.deepEqual(peer.snapshot(NOW + 10 * 60_000), f.snapshot());
	assert.equal(f.snapshot()[0].status, "stale");
	assert.equal(f.snapshot()[0].fetchedAt, NOW, "429 never refreshes an old reading's timestamp");
	assert.equal(f.snapshot()[0].message, "Usage endpoint HTTP 429");
	await f.quota.close();
	f.tick(10 * 60_000);
	await peer.refresh();
	assert.equal(calls, 2, "the ten-minute interval cannot override a longer provider deadline");
	f.tick(1040_000 - 1);
	await peer.refresh();
	assert.equal(calls, 2);
	f.tick(1); throttled = false;
	await peer.refresh();
	assert.equal(calls, 3);
	assert.equal(peer.snapshot(NOW + 600_000 + 1640_000)![0].status, "fresh");
	assert.equal(peer.snapshot(NOW + 600_000 + 1640_000)![0].message, null);
	assert.deepEqual(peer.activeCooldowns(NOW), [], "usage endpoint cooldowns do not bench inference accounts");
});

test("short or malformed Retry-After retains the ordinary Anthropic polling minimum", async (t) => {
	for (const header of ["60", "bad", "-1", "0"]) await t.test(header, async (t) => {
		let calls = 0;
		const f = monitor(t, async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": header } }); });
		f.save({ anthropic: credential });
		await f.quota.refresh();
		f.tick(600_000 - 1); await f.quota.refresh();
		assert.equal(calls, 1);
		f.tick(1); await f.quota.refresh();
		assert.equal(calls, 2);
	});
});

test("HTTP-date cooldowns survive token changes, logout/login and restarts without sharing old balances", async (t) => {
	let calls = 0;
	const f = monitor(t, async () => {
		calls++;
		return calls === 1 ? Response.json(anthropic) : new Response("", { status: 429, headers: { "Retry-After": new Date(NOW + 2 * HOUR).toUTCString() } });
	});
	f.save({ anthropic: credential });
	await f.quota.refresh();
	f.tick(600_000); await f.quota.refresh();
	f.save({}); f.quota.poll();
	f.save({ anthropic: { ...credential, access: "replacement-secret" } });
	const peer = f.newMonitor();
	await peer.refresh();
	assert.equal(calls, 2);
	assert.equal(peer.snapshot(NOW + 600_000)![0].status, "unknown");
	assert.deepEqual(peer.snapshot(NOW + 600_000)![0].windows, [], "previous credential's reading cannot leak to its replacement");
	f.tick(2 * HOUR - 600_000 - 1); await peer.refresh();
	assert.equal(calls, 2);
	f.tick(1); await peer.refresh();
	assert.equal(calls, 3);
});

test("Anthropic accounts keep independent reservations and shared storage errors fail closed", async (t) => {
	let calls = 0;
	const f = monitor(t, async () => { calls++; return Response.json(anthropic); });
	f.save({ anthropic: credential, "anthropic-account-2": { ...credential, access: "other-secret" } });
	await f.quota.refresh();
	assert.equal(calls, 2);
	const file = join(f.dir, "pi-dash", "quota", "anthropic.json");
	writeFileSync(file, "{secret-access");
	f.tick(600_000);
	await f.quota.refresh();
	assert.equal(calls, 3, "an invalid shared store blocks only that account's probe");
	assert.equal(f.snapshot()[0].message, "Shared usage state unavailable");
	assert.doesNotMatch(JSON.stringify(f.snapshot()), /secret-access|other-secret|private-account/);
});

test("separate TUI/gateway processes share a Retry-After cooldown after the owner dies", { timeout: 15_000 }, async (t) => {
	const f = monitor(t, async () => { throw new Error("parent must not fetch"); });
	f.save({ anthropic: credential });
	const events = new EventEmitter();
	const requests: number[] = [];
	const children = [0, 1].map((index) => {
		const child = fork(new URL("./fixtures/quota-controller.ts", import.meta.url), [f.dir, String(NOW)], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
		child.on("message", (message: any) => {
			if (message.type === "request") requests.push(index);
			events.emit(message.type, { index, ...message });
		});
		t.after(async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit"); child.kill(); await exited;
		});
		return child;
	});
	await Promise.all(children.map((child) => once(child, "message")));
	const request = once(events, "request");
	const skipped = once(events, "done");
	children.forEach((child) => child.send("refresh"));
	const [[owner], [peer]] = await Promise.all([request, skipped]);
	assert.notEqual(owner.index, peer.index);
	assert.equal(peer.snapshot[0].status, "unknown");
	const completed = once(events, "done");
	children[owner.index].send("throttle");
	const [result] = await completed;
	assert.equal(result.snapshot[0].status, "unknown");
	assert.equal(result.snapshot[0].message, "Usage endpoint HTTP 429");
	const exited = once(children[owner.index], "exit");
	children[owner.index].kill("SIGKILL"); await exited;
	const advanced = once(events, "clock");
	children[peer.index].send("advance"); await advanced;
	const shared = once(events, "done");
	children[peer.index].send("refresh");
	const [reading] = await shared;
	assert.deepEqual(reading.snapshot, result.snapshot);
	assert.equal(requests.length, 1, "the shared provider deadline still blocks the surviving process after ten minutes");
});

test("a late result cannot overwrite another controller's newer Retry-After", async (t) => {
	let calls = 0;
	let complete!: (response: Response) => void;
	const f = monitor(t, async () => {
		calls++;
		return calls === 1 ? new Promise<Response>((resolve) => { complete = resolve; })
			: new Response("", { status: 429, headers: { "Retry-After": "1640" } });
	});
	f.save({ anthropic: credential });
	const pending = f.quota.refresh();
	// Simulate an owner suspended longer than its reservation, despite the request timeout.
	f.tick(600_000);
	const peer = f.newMonitor();
	await peer.refresh();
	complete(Response.json(anthropic)); await pending;
	await f.quota.refresh();
	assert.equal(f.snapshot()[0].message, "Usage endpoint HTTP 429");
	assert.equal(f.snapshot()[0].fetchedAt, null, "the superseded response is never published");
	f.tick(600_000);
	await Promise.all([f.quota.refresh(), peer.refresh()]);
	assert.equal(calls, 2, "a late success cannot shorten the newer server cooldown");
});

test("known expired OAuth credentials never reach the usage transport", async () => {
	let calls = 0;
	const impl: typeof fetch = async () => { calls++; return Response.json(anthropic); };
	for (const expires of [NOW - 1, NOW]) {
		const expired = Object.freeze({ ...credential, refresh: "synthetic-refresh", expires });
		await assert.rejects(fetchProviderUsage("anthropic", expired, new AbortController().signal, impl, () => NOW),
			{ message: "OAuth refresh required in Pi" });
		assert.equal(calls, 0, "stored expiry is checked before any usage or token-refresh request");
	}
	await fetchProviderUsage("anthropic", { ...credential, expires: NOW + 1 }, new AbortController().signal, impl, () => NOW);
	assert.equal(calls, 1, "a still-valid token can be used without modifying its credentials");
});

test("local authentication failures do not reserve a shared provider cooldown", async (t) => {
	for (const [name, login, message] of [
		["expired", { ...credential, expires: NOW - 1 }, "OAuth refresh required in Pi"],
		["non-OAuth", { type: "api_key", key: "synthetic-key" }, "OAuth login required"],
	] as const) await t.test(name, async (t) => {
		let calls = 0;
		const f = monitor(t, async () => { calls++; return Response.json(anthropic); });
		f.save({ anthropic: login });
		const originalAuth = readFileSync(join(f.dir, "auth.json"), "utf8");
		await f.quota.refresh();
		assert.equal(calls, 0);
		assert.equal(f.snapshot()[0].message, message);
		assert.deepEqual(f.snapshot()[0].windows, []);
		assert.equal(existsSync(join(f.dir, "pi-dash", "quota", "anthropic.json")), false, "local failures cannot fabricate provider cooldowns");
		assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), originalAuth, "an unrenewable login leaves credentials untouched");
		f.save({ anthropic: { ...credential, expires: NOW + HOUR } });
		const peer = f.newMonitor();
		await peer.refresh();
		assert.equal(calls, 1, "a Pi-owned login refresh can be used immediately when no provider cooldown exists");
		assert.equal(peer.snapshot(NOW)![0].status, "fresh");
	});
});

/** Stands in for Pi's locked refresh: once `gate` opens it rewrites auth.json with a new access token. */
function renewedAnthropic(onRenew: () => void, gate: Promise<void> = Promise.resolve()): RenewLogin {
	return async (authFile) => {
		onRenew();
		await gate;
		const auth = JSON.parse(readFileSync(authFile, "utf8"));
		auth.anthropic = { ...auth.anthropic, access: "synthetic-renewed", expires: NOW + 8 * HOUR };
		writeFileSync(authFile, JSON.stringify(auth));
	};
}

test("an expired login is renewed once through Pi, then probed with the renewed token", async (t) => {
	const tokens: (string | null)[] = [];
	let renewals = 0, release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const f = monitor(t, async (_url, init) => { tokens.push(new Headers(init?.headers).get("Authorization")); return Response.json(anthropic); },
		undefined, renewedAnthropic(() => renewals++, gate));
	f.save({ anthropic: { ...credential, refresh: "synthetic-refresh", expires: NOW - 1 } });
	const refreshes = [f.quota.refresh(), f.quota.refresh()];
	release();
	await Promise.all(refreshes);
	assert.equal(renewals, 1, "concurrent refreshes share one renewal");
	assert.deepEqual(tokens, [], "the expired token is never sent to the usage endpoint");
	assert.equal(existsSync(join(f.dir, "pi-dash", "quota", "anthropic.json")), false, "renewal reserves no provider poll");
	await f.quota.refresh();
	assert.deepEqual(tokens, ["Bearer synthetic-renewed"]);
	assert.equal(f.snapshot()[0].status, "fresh");
	const peer = f.newMonitor();
	await peer.refresh();
	assert.equal(renewals, 1, "another dashboard on the renewed login neither renews nor probes again");
	assert.equal(tokens.length, 1);
	assert.equal(peer.snapshot(NOW)![0].status, "fresh");
});

test("a failed renewal reports a sanitized diagnostic and retries only after the backoff", async (t) => {
	let attempts = 0, calls = 0, succeed = false;
	const renewed = renewedAnthropic(() => {});
	const f = monitor(t, async () => { calls++; return Response.json(anthropic); }, undefined, async (authFile, provider) => {
		attempts++;
		if (!succeed) throw new Error("synthetic-refresh response body");
		await renewed(authFile, provider);
	});
	f.save({ anthropic: { ...credential, refresh: "synthetic-refresh", expires: NOW - 1 } });
	await f.quota.refresh();
	assert.equal(attempts, 1);
	assert.equal(f.snapshot()[0].message, "OAuth refresh required in Pi");
	assert.doesNotMatch(JSON.stringify(f.snapshot()), /synthetic|response body/);
	f.tick(5 * 60_000 - 1); await f.quota.refresh();
	assert.equal(attempts, 1, "an unchanged login is not retried inside the backoff");
	assert.equal(f.snapshot()[0].message, "OAuth refresh required in Pi");
	succeed = true; f.tick(1); await f.quota.refresh();
	assert.equal(attempts, 2);
	await f.quota.refresh();
	assert.equal(calls, 1);
	assert.equal(f.snapshot()[0].status, "fresh");
});

test("close waits for a started renewal instead of cancelling it, so a rotated refresh token is persisted", async (t) => {
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const begun = new Promise<void>((resolve) => { started = resolve; });
	const f = monitor(t, async () => Response.json(anthropic), undefined, renewedAnthropic(started, gate));
	f.save({ anthropic: { ...credential, refresh: "synthetic-refresh", expires: NOW - 1 } });
	const refreshing = f.quota.refresh();
	await begun;
	let closed = false;
	const closing = f.quota.close().then(() => { closed = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closed, false, "the process must not be allowed to exit while Pi is mid-refresh");
	assert.doesNotMatch(readFileSync(join(f.dir, "auth.json"), "utf8"), /synthetic-renewed/);
	release();
	await Promise.all([refreshing, closing]);
	assert.match(readFileSync(join(f.dir, "auth.json"), "utf8"), /synthetic-renewed/, "the renewal ran to completion and was persisted");
});

test("renewal spacing is per provider: a renewal that yields a still-expired login is not repeated or hidden", async (t) => {
	let attempts = 0;
	const f = monitor(t, async () => Response.json(anthropic), undefined, async (authFile) => {
		attempts++;
		const auth = JSON.parse(readFileSync(authFile, "utf8"));
		auth.anthropic = { ...auth.anthropic, access: `synthetic-short-${attempts}`, expires: NOW - 1 };
		writeFileSync(authFile, JSON.stringify(auth));
	});
	f.save({ anthropic: { ...credential, refresh: "synthetic-refresh", expires: NOW - 1 } });
	await f.quota.refresh();
	assert.equal(attempts, 1);
	assert.equal(f.snapshot()[0].message, "OAuth refresh required in Pi", "a replaced but expired login is still diagnosed");
	for (let tick = 0; tick < 5; tick++) { f.tick(1000); await f.quota.refresh(); }
	assert.equal(attempts, 1, "a changed credential must not restart the spacing and hammer the token endpoint");
	assert.equal(f.snapshot()[0].message, "OAuth refresh required in Pi");
	f.tick(5 * 60_000 - 5000 - 1); await f.quota.refresh();
	assert.equal(attempts, 1);
	f.tick(1); await f.quota.refresh();
	assert.equal(attempts, 2, "one further attempt once the spacing has elapsed");
});

test("only expired OAuth logins of polled providers are renewed", async (t) => {
	const renewed: string[] = [];
	const f = monitor(t, async () => Response.json(anthropic), undefined, async (_file, provider) => { renewed.push(provider); });
	f.save({
		anthropic: { ...credential, expires: NOW + 1 },
		"openai-codex": { type: "api_key", key: "synthetic-key", expires: NOW - 1 },
		"anthropic-account-2": { ...credential },
		openai: { type: "oauth", access: "synthetic", expires: NOW - 1 },
	});
	await f.quota.refresh();
	assert.deepEqual(renewed, [], "valid, unknown-expiry, non-OAuth and unsupported logins are never renewed");
	f.save({ anthropic: { ...credential, expires: NOW - 1 }, "openai-codex-account-2": { ...credential, expires: NOW - 1 } });
	await f.quota.refresh();
	assert.deepEqual(renewed.sort(), ["anthropic", "openai-codex-account-2"]);
});

test("Pi's runtime resolves a valid login without rewriting auth.json, and ignores providers it does not know", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-renew-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const login = { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 2 * HOUR };
	const file = join(dir, "auth.json");
	const auth = JSON.stringify({ anthropic: login, "anthropic-account-2": login });
	writeFileSync(file, auth);
	for (const provider of ["anthropic", "anthropic-account-2"]) await renewLoginWithPi(file, provider);
	assert.equal(readFileSync(file, "utf8"), auth);
	assert.deepEqual(readdirSync(dir), ["auth.json"]);
});

test("expiry checks and refreshed credentials cannot erase an actual Retry-After deadline", async (t) => {
	let calls = 0;
	const f = monitor(t, async () => {
		calls++;
		return calls === 1 ? new Response("", { status: 429, headers: { "Retry-After": "1640" } }) : Response.json(anthropic);
	});
	f.save({ anthropic: { ...credential, expires: NOW + 600_000 } });
	await f.quota.refresh();
	const file = join(f.dir, "pi-dash", "quota", "anthropic.json");
	const providerState = readFileSync(file, "utf8");
	f.tick(600_000); await f.quota.refresh();
	assert.equal(calls, 1);
	assert.equal(f.snapshot()[0].message, "OAuth refresh required in Pi");
	assert.equal(readFileSync(file, "utf8"), providerState, "local expiry cannot replace the provider's existing deadline");
	f.save({ anthropic: { ...credential, access: "synthetic-refreshed", expires: NOW + 24 * HOUR } });
	const peer = f.newMonitor();
	await peer.refresh();
	assert.equal(calls, 1);
	assert.deepEqual(peer.snapshot(NOW + 600_000)![0].windows, []);
	f.tick(1040_000 - 1); await peer.refresh(); assert.equal(calls, 1);
	f.tick(1); await peer.refresh(); assert.equal(calls, 2);
	assert.equal(peer.snapshot(NOW + 1640_000)![0].status, "fresh");
});

test("HTTP authentication errors and Retry-After survive when response-body cleanup fails", async () => {
	for (const status of [401, 403, 429]) {
		let cancelled = 0;
		const body = new ReadableStream({ cancel() { cancelled++; throw new Error("secret cleanup failure"); } });
		await assert.rejects(fetchProviderUsage("anthropic", credential, new AbortController().signal,
			async () => new Response(body, { status, headers: { "Retry-After": "1640" } }), () => NOW), (error: unknown) => {
			assert.ok(error instanceof UsageFetchError);
			assert.equal(error.message, status === 429 ? "Usage endpoint HTTP 429" : `HTTP ${status}: refresh login in Pi`);
			assert.equal(error.retryAt, NOW + 1640_000);
			assert.doesNotMatch(JSON.stringify(error), /secret|cleanup/);
			return true;
		});
		assert.equal(cancelled, 1);
	}
});

test("token expiry after preflight releases its reservation without a provider request", async (t) => {
	for (const closeDuringRejection of [false, true]) await t.test(closeDuringRejection ? "owner closes" : "owner stays open", async (t) => {
		let reads = 0, calls = 0;
		const f = monitor(t, async () => { calls++; return Response.json(anthropic); }, () => reads++ === 0 ? NOW : NOW + 2);
		f.save({ anthropic: { ...credential, expires: NOW + 1 } });
		const pending = f.quota.refresh();
		if (closeDuringRejection) await f.quota.close();
		await pending;
		assert.equal(calls, 0, "the adapter rejects expiry between the preflight and transport checks");
		if (!closeDuringRejection) assert.equal(f.quota.snapshot(NOW + 2)![0].message, "OAuth refresh required in Pi");
		f.save({ anthropic: { ...credential, access: "synthetic-refreshed", expires: NOW + HOUR } });
		const auth = readFileSync(join(f.dir, "auth.json"), "utf8");
		const peer = f.newMonitor();
		await peer.refresh();
		assert.equal(calls, 1, "a local-only rejection must not impose a ten-minute wait on valid refreshed credentials");
		assert.equal(peer.snapshot(NOW + 2)![0].status, "fresh");
		assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), auth);
	});
});

test("a late 429 extends the current cooldown without replacing newer credentials or readings", async (t) => {
	let calls = 0;
	let complete!: (response: Response) => void;
	const f = monitor(t, async () => {
		calls++;
		return calls === 1 ? new Promise<Response>((resolve) => { complete = resolve; })
			: Response.json({ five_hour: { utilization: 42, resets_at: NOW + 3 * HOUR } });
	});
	f.save({ anthropic: { ...credential, expires: NOW + 24 * HOUR } });
	const pending = f.quota.refresh();
	f.tick(600_000);
	f.save({ anthropic: { ...credential, access: "synthetic-refreshed", expires: NOW + 24 * HOUR } });
	const peer = f.newMonitor();
	await peer.refresh();
	const file = join(f.dir, "pi-dash", "quota", "anthropic.json");
	const newer = JSON.parse(readFileSync(file, "utf8"));
	complete(new Response("", { status: 429, headers: { "Retry-After": "3600" } }));
	await pending;
	const merged = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(merged.nextAt, NOW + 4200_000);
	assert.equal(merged.credentialKey, newer.credentialKey);
	assert.equal(merged.reservation, newer.reservation);
	assert.deepEqual(merged.reading, newer.reading, "only the deadline is merged from a superseded response");
	await f.quota.refresh();
	assert.deepEqual(f.quota.snapshot(NOW + 600_000), peer.snapshot(NOW + 600_000));
	assert.equal(peer.snapshot(NOW + 600_000)![0].windows[0].usedPercent, 42);
	f.tick(600_000);
	await Promise.all([f.quota.refresh(), peer.refresh()]);
	assert.equal(calls, 2, "no third probe at twenty minutes when the late 429 requires seventy");
	f.tick(3000_000 - 1);
	await Promise.all([f.quota.refresh(), peer.refresh()]);
	assert.equal(calls, 2);
	f.tick(1);
	await Promise.all([f.quota.refresh(), peer.refresh()]);
	await Promise.all([f.quota.refresh(), peer.refresh()]);
	assert.equal(calls, 3, "one shared probe is allowed at the extended deadline");
	assert.equal(peer.snapshot(NOW + 4200_000)![0].status, "fresh");
	assert.deepEqual(f.quota.snapshot(NOW + 4200_000), peer.snapshot(NOW + 4200_000));
});

test("lease cancellation preserves another owner and any merged server deadline", (t) => {
	const f = monitor(t, async () => { throw new Error("must not fetch"); });
	const state = new SharedUsageState(join(f.dir, "auth.json"));
	const old = state.claim("anthropic", "a".repeat(64), NOW, 600_000);
	const current = state.claim("anthropic", "b".repeat(64), NOW + 600_000, 600_000);
	assert.equal(current.claimed, true);
	state.cancel("anthropic", old.state.reservation);
	assert.equal(state.read("anthropic")!.pendingUntil, NOW + 1200_000, "a stale owner cannot cancel the newer lease");
	const failure = { fetchedAt: null, windows: [], error: "Usage endpoint HTTP 429" };
	state.backoff("anthropic", NOW + 4200_000);
	assert.equal(state.complete("anthropic", old.state.reservation, NOW + 4200_000, failure), false);
	const merged = state.read("anthropic")!;
	assert.equal(merged.nextAt, NOW + 4200_000);
	assert.equal(merged.pendingUntil, NOW + 1200_000, "merging a deadline must not release an in-flight request");
	state.backoff("anthropic", NOW + 1800_000);
	state.complete("anthropic", old.state.reservation, NOW + 1800_000, failure);
	assert.deepEqual(state.read("anthropic"), merged, "a shorter late Retry-After cannot reduce the deadline");
	state.cancel("anthropic", current.state.reservation);
	assert.equal(state.read("anthropic")!.pendingUntil, undefined);
	assert.equal(state.read("anthropic")!.nextAt, NOW + 4200_000, "cancellation removes only the lease, never a server deadline");
	assert.equal(state.claim("anthropic", "c".repeat(64), NOW + 1200_000, 600_000).claimed, false);
});

test("current success retains a longer Retry-After merged while it was pending", (t) => {
	const f = monitor(t, async () => { throw new Error("must not fetch"); });
	const state = new SharedUsageState(join(f.dir, "auth.json"));
	const old = state.claim("anthropic", "a".repeat(64), NOW, 600_000);
	const current = state.claim("anthropic", "b".repeat(64), NOW + 600_000, 600_000);
	state.backoff("anthropic", NOW + 4200_000);
	assert.equal(state.complete("anthropic", old.state.reservation, NOW + 4200_000,
		{ fetchedAt: null, windows: [], error: "Usage endpoint HTTP 429" }), false);
	const reading = { fetchedAt: NOW + 600_000, windows: [{ label: "5h", usedPercent: 12, resetAt: NOW + 3 * HOUR }] };
	assert.equal(state.complete("anthropic", current.state.reservation, NOW + 1200_000, reading), true);
	assert.equal(state.read("anthropic")!.nextAt, NOW + 4200_000, "a current reading cannot undo a server cooldown already observed");
	assert.deepEqual(state.read("anthropic")!.reading, reading);
	assert.equal(state.read("anthropic")!.pendingUntil, undefined);
});

test("a known Retry-After is retained even if the owner closes during response cleanup", async (t) => {
	let calls = 0;
	let closed!: Promise<void>;
	const f = monitor(t, async () => {
		calls++;
		return calls === 1 ? new Response(new ReadableStream({ cancel() { closed = f.quota.close(); } }),
			{ status: 429, headers: { "Retry-After": "1640" } }) : Response.json(anthropic);
	});
	f.save({ anthropic: credential });
	await f.quota.refresh(); await closed;
	assert.equal(f.snapshot()[0].fetchedAt, null, "closing does not publish the request's reading");
	const peer = f.newMonitor();
	await peer.refresh(); assert.equal(calls, 1);
	f.tick(600_000); await peer.refresh();
	assert.equal(calls, 1, "closing cannot discard an already observed server Retry-After");
	f.tick(1040_000); await peer.refresh();
	assert.equal(calls, 2);
	assert.equal(peer.snapshot(NOW + 1640_000)![0].status, "fresh");
});

test("Anthropic's scoped weekly pools are their own windows beside the all-model week", () => {
	const scoped = { kind: "weekly_scoped", group: "weekly", percent: 88, resets_at: new Date(NOW + 2 * 86400_000).toISOString(), scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true };
	const all = { kind: "weekly_all", group: "weekly", percent: 57, resets_at: new Date(NOW + 3 * 86400_000).toISOString(), scope: null, is_active: false };
	assert.deepEqual(parseUsage("anthropic", { ...anthropic, limits: [all, scoped] }), [
		{ label: "5h", usedPercent: 25, resetAt: NOW + HOUR },
		{ label: "7d", usedPercent: 57, resetAt: NOW + 3 * 86400_000 },
		{ label: "7d fable", usedPercent: 88, resetAt: NOW + 2 * 86400_000 },
	]);
	assert.deepEqual(parseUsage("anthropic", anthropic).map(({ label }) => label), ["5h", "7d"], "an absent scoped pool is not invented");
	// A scoped pool without a percentage, reset, model name or safe label stays unknown.
	for (const bad of [
		{ ...scoped, percent: null },
		{ ...scoped, percent: -1 },
		{ ...scoped, resets_at: "bad" },
		{ ...scoped, scope: { model: { display_name: "" } } },
		{ ...scoped, scope: { model: { display_name: "Fable\u001b[31m" } } },
		{ ...scoped, scope: { surface: { display_name: "Chat" } } },
		{ ...scoped, kind: "weekly_all" },
	]) {
		assert.deepEqual(parseUsage("anthropic", { ...anthropic, limits: [bad] }).map(({ label }) => label), ["5h", "7d"]);
	}
	// A repeated scope adds one line; a name with spaces is slugged, never rendered raw.
	assert.deepEqual(parseUsage("anthropic", { ...anthropic, limits: [scoped, scoped] }).map(({ label }) => label), ["5h", "7d", "7d fable"]);
	assert.deepEqual(parseUsage("anthropic", { ...anthropic, limits: [{ ...scoped, scope: { model: { display_name: "Claude Opus 4.5" } } }] }).map(({ label }) => label), ["5h", "7d", "7d claude-opus-4.5"]);
	assert.deepEqual(parseUsage("codex", { ...codex, limits: [scoped] }).map(({ label }) => label), ["30d"], "only Anthropic reports scoped pools");
});

test("a captured Anthropic body keeps the all-model week and adds each scoped pool once", () => {
	const body: unknown = JSON.parse(readFileSync(new URL("./fixtures/anthropic-usage.json", import.meta.url), "utf8"));
	const reset = (second: number) => Date.parse(`2026-11-27T03:00:0${second}.000000+00:00`);
	const windows = parseUsage("anthropic", body);
	assert.deepEqual(windows, [
		{ label: "7d", usedPercent: 74, resetAt: reset(0) },
		{ label: "7d fable", usedPercent: 100, resetAt: reset(1) },
		{ label: "7d cowork", usedPercent: 12, resetAt: reset(2) },
	]);
	// The all-model week keeps its own reported percentage and reset, untouched by the scoped pools.
	assert.deepEqual(windows[0], { label: "7d", usedPercent: 74, resetAt: Date.parse("2026-11-27T03:00:00.000000+00:00") });
	// A repeated scope, a control-character name, a surface-only scope and a missing percentage stay out.
	assert.equal(windows.length, 3);
	assert.ok(!windows.some(({ label }) => label.includes("\u001b")));
	// five_hour is null in the capture, so no five-hour line is invented.
	assert.deepEqual(windows.map(({ label }) => label), ["7d", "7d fable", "7d cowork"]);
});

test("Antigravity's summary keeps one five-hour and one weekly window per shared pool", () => {
	const weekly = (remainingFraction: unknown, resetTime: unknown = new Date(NOW + 5 * 86400_000).toISOString()) =>
		({ window: "weekly", bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", remainingFraction, resetTime });
	const fiveHour = (remainingFraction: unknown, resetTime: unknown = new Date(NOW + HOUR).toISOString()) =>
		({ window: "5h", bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", remainingFraction, resetTime });
	assert.deepEqual(parseUsage("antigravity", { groups: [{ displayName: "Claude and GPT models", buckets: [weekly(0.9), fiveHour(0.4)] }] }, NOW), [
		{ label: "5h", usedPercent: 60, resetAt: NOW + HOUR },
		{ label: "7d", usedPercent: 10, resetAt: NOW + 5 * 86400_000 },
	]);
	// Several pools keep their group name beside each duration.
	assert.deepEqual(parseUsage("antigravity", { groups: [
		{ displayName: "Claude and GPT models", buckets: [fiveHour(0.4), weekly(0.9)] },
		{ displayName: "Gemini models", buckets: [fiveHour(0.5), weekly(0.5)] },
	] }, NOW), [
		{ label: "5h claude-and-gpt-models", usedPercent: 60, resetAt: NOW + HOUR },
		{ label: "7d claude-and-gpt-models", usedPercent: 10, resetAt: NOW + 5 * 86400_000 },
		{ label: "5h gemini-models", usedPercent: 50, resetAt: NOW + HOUR },
		{ label: "7d gemini-models", usedPercent: 50, resetAt: NOW + 5 * 86400_000 },
	]);
	// A single pool with only one usable bucket keeps that bucket.
	assert.deepEqual(parseUsage("antigravity", { groups: [{ displayName: "Claude and GPT models", buckets: [weekly(0.9)] }] }, NOW), [
		{ label: "7d", usedPercent: 10, resetAt: NOW + 5 * 86400_000 },
	]);
	assert.deepEqual(parseUsage("antigravity", { groups: [{ displayName: "Claude and GPT models", buckets: [fiveHour(0.4)] }] }, NOW), [
		{ label: "5h", usedPercent: 60, resetAt: NOW + HOUR },
	]);
	// Out-of-range or missing fractions, a bad reset and an empty group stay out.
	assert.deepEqual(parseUsage("antigravity", { groups: [
		{ displayName: "A", buckets: [fiveHour(2)] },
		{ displayName: "B", buckets: [weekly(undefined)] },
		{ displayName: "C", buckets: [weekly(0.5, "bad")] },
		{ displayName: "D", buckets: [fiveHour(0.5, "bad")] },
		{ displayName: "E", buckets: [] },
	] }, NOW), []);
	assert.deepEqual(parseUsage("antigravity", { groups: [{ displayName: undefined, buckets: [weekly(0.5)] }, { displayName: "Gemini", buckets: [weekly(0.5)] }] }, NOW).map(({ label }) => label), ["7d gemini"]);
	assert.deepEqual(parseUsage("antigravity", { groups: [{ displayName: "Claude and GPT models", buckets: [weekly(0.5)] }, { displayName: "Claude and GPT models", buckets: [weekly(0.5)] }] }, NOW).map(({ label }) => label), ["7d"], "a repeated pool is one line");
	assert.deepEqual(parseUsage("antigravity", {}, NOW), [], "an HTTP success alone is not quota data");
	assert.deepEqual(parseUsage("antigravity", { groups: "bad" }, NOW), []);
});

/** The ACP server's own login file, with synthetic values; no real token is ever used here. */
function acpFixture(t: TestContext, token: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "acp_token.json");
	writeFileSync(file, JSON.stringify({
		client_id: "acp-client", client_secret: "acp-secret", refresh_token: "acp-refresh",
		token_uri: "https://oauth2.googleapis.com/token", project_id: "acp-project", ...token,
	}));
	return { dir, file };
}

const ACP_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const ACP_FALLBACK_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const acpCredential = { type: "oauth", access: "antigravity-acp-managed", refresh: "antigravity-acp-managed", expires: NOW + 86400_000 };

test("the ACP token file is resolved from the server's own Gemini home", () => {
	assert.equal(resolveAcpTokenFile({ HOME: "/home/user" }), join("/home/user", ".gemini", "antigravity-acp", "acp_token.json"));
	assert.equal(resolveAcpTokenFile({ HOME: "/home/user", GEMINI_HOME: "~/gemini" }), join("/home/user", "gemini", "antigravity-acp", "acp_token.json"));
	assert.equal(resolveAcpTokenFile({ HOME: "/home/user", GEMINI_HOME: "/opt/gemini" }), join("/opt/gemini", "antigravity-acp", "acp_token.json"));
});

test("the Antigravity ACP login exchanges its own refresh token and reads the weekly quota summary", async (t) => {
	const { file } = acpFixture(t);
	const calls: string[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		if (url === "https://oauth2.googleapis.com/token") {
			assert.equal(init?.method, "POST");
			assert.equal(init?.redirect, "error");
			const form = new URLSearchParams(String(init?.body));
			assert.equal(form.get("grant_type"), "refresh_token");
			assert.equal(form.get("client_id"), "acp-client");
			assert.equal(form.get("client_secret"), "acp-secret");
			assert.equal(form.get("refresh_token"), "acp-refresh");
			return Response.json({ access_token: "google-access", expires_in: 3600 });
		}
		assert.equal(url, ACP_QUOTA_URL);
		assert.equal(init?.method, "POST");
		assert.equal(init?.redirect, "error");
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("Authorization"), "Bearer google-access");
		assert.equal(headers.get("Content-Type"), "application/json");
		assert.match(headers.get("User-Agent") ?? "", /^antigravity\/\d/);
		assert.deepEqual(JSON.parse(String(headers.get("Client-Metadata"))), { ideType: "ANTIGRAVITY", platform: "DARWIN_ARM64", pluginType: "CLOUD_CODE", ideName: "antigravity" });
		assert.deepEqual(JSON.parse(String(init?.body)), { project: "acp-project" });
		return Response.json({ groups: [{ displayName: "Claude and GPT models", buckets: [
			{ window: "5h", remainingFraction: 0.9, resetTime: new Date(NOW + HOUR).toISOString() },
			{ window: "weekly", remainingFraction: 0.9, resetTime: new Date(NOW + 5 * 86400_000).toISOString() },
		] }] });
	};
	const windows = await fetchProviderUsage("google-antigravity-acp", acpCredential, new AbortController().signal, impl as typeof fetch, () => NOW, file);
	assert.deepEqual(windows, [
		{ label: "5h", usedPercent: 10, resetAt: NOW + HOUR },
		{ label: "7d", usedPercent: 10, resetAt: NOW + 5 * 86400_000 },
	]);
	assert.deepEqual(calls, ["https://oauth2.googleapis.com/token", ACP_QUOTA_URL]);
	assert.doesNotMatch(JSON.stringify(windows), /acp-secret|acp-refresh|google-access|acp-project/);
});

test("the ACP quota fails closed on a missing, incomplete or foreign login without any request", async (t) => {
	const unexpected: typeof fetch = async () => { throw new Error("must not fetch"); };
	const request = (file: string, impl: typeof fetch = unexpected) => fetchProviderUsage("google-antigravity-acp", acpCredential, new AbortController().signal, impl, () => NOW, file);
	const { dir, file } = acpFixture(t);
	await assert.rejects(request(join(dir, "missing.json")), { message: "ACP login not found" });
	writeFileSync(file, "{");
	await assert.rejects(request(file), { message: "ACP token file is unreadable" });
	writeFileSync(file, JSON.stringify({ client_id: "a", client_secret: "b", refresh_token: "c", token_uri: "https://oauth2.googleapis.com/token" }));
	await assert.rejects(request(file), { message: "ACP token file is incomplete" });
	// The endpoint comes from a local file, so only Google's own token endpoint may receive the secret.
	writeFileSync(file, JSON.stringify({ client_id: "a", client_secret: "b", refresh_token: "c", project_id: "p", token_uri: "https://evil.example/token" }));
	await assert.rejects(request(file), { message: "ACP token file has an unsupported token endpoint" });
	writeFileSync(file, JSON.stringify({ client_id: "a", client_secret: "b", refresh_token: "c", project_id: "p", token_uri: "https://oauth2.googleapis.com/token" }));
	await assert.rejects(request(file, async () => new Response("secret", { status: 400 })), { message: "ACP login needs re-authentication" });
	await assert.rejects(request(file, async () => { throw new Error("secret"); }), { message: "ACP token request failed or timed out" });
	await assert.rejects(request(file, async () => Response.json({})), { message: "ACP token response has no access token" });
});

test("the ACP quota cascades a gated endpoint, reports the last answer and never exposes the token", async (t) => {
	const { file } = acpFixture(t);
	const quota = (url: string) => url === "https://oauth2.googleapis.com/token";
	const urls: string[] = [];
	const cascade = async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		if (quota(url)) return Response.json({ access_token: "google-access" });
		if (url === ACP_QUOTA_URL) return new Response("secret", { status: 403 });
		return Response.json({ groups: [{ displayName: "Gemini models", buckets: [{ window: "weekly", remainingFraction: 0.5 }] }] });
	};
	const windows = await fetchProviderUsage("google-antigravity-acp", acpCredential, new AbortController().signal, cascade as typeof fetch, () => NOW, file);
	assert.deepEqual(urls, ["https://oauth2.googleapis.com/token", ACP_QUOTA_URL, ACP_FALLBACK_URL]);
	assert.deepEqual(windows, [{ label: "7d", usedPercent: 50, resetAt: null }]);
	// The last endpoint's answer stands: a 403 there is the provider's verdict, not another endpoint to try.
	await assert.rejects(fetchProviderUsage("google-antigravity-acp", acpCredential, new AbortController().signal,
		async (input) => String(input) === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "google-access" }) : new Response("secret", { status: 403 }), () => NOW, file), { message: "Usage endpoint HTTP 403" });
	await assert.rejects(fetchProviderUsage("google-antigravity-acp", acpCredential, new AbortController().signal,
		async (input) => String(input) === "https://oauth2.googleapis.com/token" ? Response.json({ access_token: "google-access" }) : Response.json({ groups: [] }), () => NOW, file), { message: "Provider returned no quota windows" });
});

test("the ACP login polls slowly and is never renewed through Pi's runtime", async (t) => {
	const { dir, file } = acpFixture(t);
	let now = NOW;
	let calls = 0;
	let renewed = 0;
	const quota = new QuotaMonitor(join(dir, "multi-login-state.json"), join(dir, "auth.json"), {
		fetch: async (input) => {
			calls++;
			return String(input) === "https://oauth2.googleapis.com/token"
				? Response.json({ access_token: "google-access" })
				: Response.json({ groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.75, resetTime: new Date(now + 5 * 86400_000).toISOString() }] }] });
		},
		now: () => now,
		renew: async () => { renewed++; },
		acpTokenFile: file,
	});
	t.after(() => quota.close());
	// The marker's own expiry is meaningless: the server holds the real login.
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "google-antigravity-acp": { ...acpCredential, expires: NOW - 86400_000 } }));
	quota.poll();
	await quota.refresh();
	assert.equal(renewed, 0, "Pi's runtime cannot renew an extension-owned login");
	assert.deepEqual(quota.snapshot(now), [{
		provider: "google-antigravity-acp", status: "fresh", fetchedAt: now, freshUntil: now + 20 * 60_000, message: null,
		windows: [{ label: "7d", usedPercent: 25, resetAt: now + 5 * 86400_000 }],
	}]);
	assert.equal(calls, 2);
	await quota.refresh();
	assert.equal(calls, 2, "ten-minute interval");
	now += 10 * 60_000;
	await quota.refresh();
	assert.equal(calls, 4);
	// A vanished ACP login is a local diagnostic: the old reading stays visible, stale, and no request is made.
	rmSync(file);
	now += 10 * 60_000;
	await quota.refresh();
	assert.equal(calls, 4);
	assert.equal(quota.snapshot(now)![0].status, "stale");
	assert.equal(quota.snapshot(now)![0].message, "ACP login not found");
});

test("shared Anthropic state carries the separately metered Fable week", (t) => {
	const { dir } = acpFixture(t);
	const state = new SharedUsageState(join(dir, "auth.json"));
	const claim = state.claim("anthropic", "a".repeat(64), NOW, 600_000);
	const reading = { fetchedAt: NOW, windows: [
		{ label: "5h", usedPercent: 0, resetAt: null },
		{ label: "7d", usedPercent: 57, resetAt: NOW + 3 * 86400_000 },
		{ label: "7d fable", usedPercent: 88, resetAt: NOW + 2 * 86400_000 },
		{ label: "7d cowork", usedPercent: 10, resetAt: NOW + 2 * 86400_000 },
	] };
	assert.equal(state.complete("anthropic", claim.state.reservation, NOW + 600_000, reading), true);
	assert.deepEqual(state.read("anthropic")!.reading, reading);
	assert.match(readFileSync(join(state.dir, "anthropic.json"), "utf8"), /7d fable/);
});
