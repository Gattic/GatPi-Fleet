import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { usageReport } from "../src/server/usage.ts";

function fixture(t: TestContext) {
	const agent = mkdtempSync(join(tmpdir(), "pi-dash-quota-"));
	t.after(() => rmSync(agent, { recursive: true, force: true }));
	const save = (file: string, value: unknown) => writeFileSync(join(agent, file), JSON.stringify(value));
	save("auth.json", { anthropic: { type: "oauth", access: "not-exposed" }, "openai-codex-account-2": { type: "oauth" } });
	const runtime = new ManagerRuntime({ agent });
	return { agent, save, runtime };
}

test("legacy snapshots never become current quotas, even with fresh timestamps", (t) => {
	const { runtime, save } = fixture(t);
	const now = Date.now();
	for (const fetchedAt of [now - 39 * 3_600_000, now]) {
		save("provider-failover-state.json", {
			usageByProvider: { anthropic: { fetchedAt, primary: { usedPercent: 11, resetAt: now + 3_600_000, windowSeconds: 18000 } } },
			exhaustedUntilByProvider: { anthropic: now + 3_600_000 },
		});
		runtime.quota.poll();
		const report = usageReport(runtime, now);
		assert.deepEqual(report.quota?.map(({ provider, status }) => ({ provider, status })), [{ provider: "anthropic", status: "unknown" }, { provider: "codex#2", status: "unknown" }]);
		assert.deepEqual(report.cooldowns, [], "a missing multi-login file means no recorded cooldown, not legacy exhaustion");
		assert.doesNotMatch(JSON.stringify(report), /usedPercent|resetAt|not-exposed/);
	}
});

test("multi-login cooldowns are independent, account-scoped, and expire without file changes", (t) => {
	const { runtime, save } = fixture(t);
	const now = Date.now();
	save("multi-login-state.json", { cooldowns: { anthropic: now + 60_000, "openai-codex-account-2": now, removed: now + 120_000 } });
	runtime.quota.poll();
	assert.deepEqual(usageReport(runtime, now).cooldowns, [{ provider: "anthropic", until: now + 60_000 }]);
	assert.deepEqual(usageReport(runtime, now + 60_000).cooldowns, []);
	assert.ok(usageReport(runtime, now + 60_000).quota?.every((account) => account.status === "unknown"));
	save("multi-login-state.json", { cooldowns: { "openai-codex-account-2": now + 120_000 } });
	runtime.quota.poll();
	assert.deepEqual(usageReport(runtime, now).cooldowns, [{ provider: "codex#2", until: now + 120_000 }]);
	save("auth.json", { anthropic: {} });
	runtime.quota.poll();
	assert.deepEqual(usageReport(runtime, now).cooldowns, [], "removed logins are no longer shown");
});

test("unreadable or invalid state is unknown, never stale or silently available, and recovers", (t) => {
	const { runtime, save, agent } = fixture(t);
	const now = Date.now();
	save("multi-login-state.json", { cooldowns: { anthropic: now + 60_000 } });
	runtime.quota.poll();
	for (const state of ["{", "null", "{}", '{"cooldowns":[]}', '{"cooldowns":{"anthropic":"tomorrow"}}']) {
		writeFileSync(join(agent, "multi-login-state.json"), state);
		runtime.quota.poll();
		assert.equal(usageReport(runtime, now).cooldowns, null);
		assert.ok(usageReport(runtime, now).quota?.every((account) => account.status === "unknown"));
	}
	save("multi-login-state.json", { cooldowns: {} });
	runtime.quota.poll();
	assert.deepEqual(usageReport(runtime, now).cooldowns, []);
	rmSync(join(agent, "auth.json"));
	runtime.quota.poll();
	assert.equal(usageReport(runtime, now).quota, null);
	assert.equal(usageReport(runtime, now).cooldowns, null);
	save("auth.json", {});
	runtime.quota.poll();
	assert.deepEqual(usageReport(runtime, now).quota, []);
	assert.deepEqual(usageReport(runtime, now).cooldowns, []);
});
