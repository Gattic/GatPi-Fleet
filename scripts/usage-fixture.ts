// The usage report in api/fixtures/usage.json: Android tests decode it, host tests check it is current.
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { emptyUsage } from "../src/protocol/index.ts";
import { usageReport } from "../src/server/usage.ts";

const NOW = Date.UTC(2026, 0, 15, 12);
const HOUR = 3_600_000;

/** "Today" starts at local midnight, so call with TZ=UTC for the same report everywhere. */
export function usageFixture() {
	const runtime = new ManagerRuntime();
	runtime.store.setState(11, { pid: 11, instanceId: "incarnation", sessionId: "open-session", cwd: "/home/user/dev/pi-dash", phase: "idle", phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [] });
	const hour = (ms: number) => String(Math.floor(ms / HOUR));
	runtime.usage.apply({
		type: "update",
		scanned: true,
		durationMs: 0,
		removed: [],
		changed: [
			{ path: "/open.jsonl", kind: "session", sessionId: "open-session", cwd: "/home/user/dev/pi-dash", size: 1, mtimeMs: 1, offset: 1, hours: { [hour(NOW)]: { "anthropic/claude-opus": { tokens: 2e6, cost: 3, cacheRead: 1.5e6, prompt: 1.9e6 } } } },
			{ path: "/subagent.jsonl", kind: "subagent", parentSessionId: "open-session", cwd: "/home/user/dev/pi-dash", size: 1, mtimeMs: 1, offset: 1, hours: { [hour(NOW - HOUR)]: { "anthropic/claude-opus": { tokens: 1e5, cost: 0.25, cacheRead: 0, prompt: 1e5 } } } },
			{ path: "/ended.jsonl", kind: "session", sessionId: "ended", cwd: "/home/user/dev/site", firstPrompt: "Fix the header", size: 1, mtimeMs: 1, offset: 1, hours: { [hour(NOW - 30 * HOUR)]: { "openai-codex/gpt-6": { tokens: 5e6, cost: 0, cacheRead: 0, prompt: 0 }, "openai-codex-account-2/gpt-6": { tokens: 1e6, cost: 0, cacheRead: 0, prompt: 0 } } } },
		],
	});
	runtime.quota.windows = [
		{ provider: "anthropic", providerLabel: "anthropic", label: "5h", usedPercent: 24, resetAt: NOW + 2 * HOUR, windowSeconds: 18_000, fetchedAt: NOW },
		{ provider: "openai-codex", providerLabel: "codex", label: "wk", usedPercent: 100, resetAt: NOW + 72 * HOUR, windowSeconds: 604_800, fetchedAt: NOW, exhaustedUntil: NOW + HOUR },
	];
	return usageReport(runtime, NOW);
}
