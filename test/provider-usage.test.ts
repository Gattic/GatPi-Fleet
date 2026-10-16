import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fetchProviderUsage, parseUsage, UsageFetchError } from "../src/manager/collectors/provider-usage.ts";
import { QuotaMonitor } from "../src/manager/collectors/quota.ts";
import { SharedUsageState } from "../src/manager/collectors/quota-state.ts";

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

test("quota failures are bounded and never expose raw bodies or errors", async () => {
	const request = (impl: typeof fetch) => fetchProviderUsage("anthropic", credential, new AbortController().signal, impl);
	await assert.rejects(request(async () => new Response("secret-access", { status: 401 })), { message: "HTTP 401: refresh login in Pi" });
	await assert.rejects(request(async () => { throw new Error("secret-access"); }), { message: "Usage request failed or timed out" });
	await assert.rejects(request(async () => new Response("not JSON secret-access")), { message: "Usage request failed or timed out" });
	await assert.rejects(request(async () => Response.json({})), /no quota windows/);
	await assert.rejects(request(async () => new Response("x".repeat(65537))), /too large/);
});

function monitor(t: TestContext, impl: typeof fetch, clock?: () => number) {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-"));
	let now = NOW;
	const save = (value: unknown) => writeFileSync(join(dir, "auth.json"), JSON.stringify(value));
	save({ anthropic: credential, "openai-codex-account-2": credential, openai: credential });
	const monitors: QuotaMonitor[] = [];
	const newMonitor = () => {
		const quota = new QuotaMonitor(join(dir, "multi-login-state.json"), join(dir, "auth.json"), { fetch: impl, now: clock ?? (() => now) });
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
		assert.equal(readFileSync(join(f.dir, "auth.json"), "utf8"), originalAuth, "the collector never refreshes/writes credentials");
		f.save({ anthropic: { ...credential, expires: NOW + HOUR } });
		const peer = f.newMonitor();
		await peer.refresh();
		assert.equal(calls, 1, "a Pi-owned login refresh can be used immediately when no provider cooldown exists");
		assert.equal(peer.snapshot(NOW)![0].status, "fresh");
	});
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
