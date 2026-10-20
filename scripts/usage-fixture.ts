// The usage report in api/fixtures/usage.json: Android tests decode it, host tests check it is current.
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { emptyUsage } from "../src/protocol/index.ts";
import { usageReport } from "../src/server/usage.ts";

const NOW = Date.UTC(2026, 0, 15, 12);
const HOUR = 3_600_000;

/** "Today" starts at local midnight, so call with TZ=UTC for the same report everywhere. */
export function usageFixture() {
	const runtime = new ManagerRuntime({ hosts: ["box00", "boxhome"] });
	const state = (pid: number, sessionId: string, cwd: string) => ({ pid, instanceId: `incarnation-${pid}`, sessionId, cwd, phase: "idle" as const, phaseSince: 1, lastEventAt: 1, usage: { direct: emptyUsage(), indirect: emptyUsage() }, usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [] });
	runtime.store.setState(11, state(11, "open-session", "/home/user/dev/pi-dash"));
	runtime.store.setState(12, state(12, "remote-open", "/home/user/dev/train"), "box00");
	runtime.network.remote("box00").status = { kind: "online", since: 1, hostname: "box00" };
	runtime.network.remote("boxhome").status = { kind: "offline", since: 1, error: "ssh: connect timed out" };
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
	// Remote files are indexed by their own host's relay. boxhome was reachable earlier, so its usage stays counted.
	runtime.usage.applyRemote("box00", {
		reset: true,
		scanned: true,
		removed: [],
		changed: [
			{ path: "/home/user/.pi/agent/sessions/open.jsonl", kind: "session", sessionId: "remote-open", cwd: "/home/user/dev/train", size: 1, mtimeMs: 1, offset: 1, hours: { [hour(NOW)]: { "anthropic/claude-opus": { tokens: 1e6, cost: 1.5, cacheRead: 0, prompt: 0 } } } },
			{ path: "/home/user/.pi/agent/sessions/ended.jsonl", kind: "session", sessionId: "remote-ended", cwd: "/home/user/dev/train", firstPrompt: "Evaluate the run", size: 1, mtimeMs: 1, offset: 1, hours: { [hour(NOW - 30 * HOUR)]: { "openai-codex/gpt-6": { tokens: 2e6, cost: 0, cacheRead: 0, prompt: 0 } } } },
		],
	});
	runtime.usage.applyRemote("boxhome", {
		reset: true,
		scanned: true,
		removed: [],
		changed: [{ path: "/home/user/.pi/agent/sessions/notes.jsonl", kind: "session", sessionId: "home-ended", cwd: "/home/user/dev/notes", name: "Release notes", size: 1, mtimeMs: 1, offset: 1, hours: { [hour(NOW - 50 * HOUR)]: { "anthropic/claude-opus": { tokens: 5e5, cost: 0.75, cacheRead: 0, prompt: 0 } } } }],
	});
	runtime.quota.providers = ["anthropic", "openai-codex"];
	runtime.quota.readings.set("anthropic", { fetchedAt: NOW, windows: [{ label: "5h", usedPercent: 0, resetAt: null }, { label: "7d", usedPercent: 57, resetAt: NOW + 3 * 24 * HOUR }] });
	runtime.quota.readings.set("openai-codex", { fetchedAt: NOW - 5 * 60_000, windows: [{ label: "7d", usedPercent: 7, resetAt: NOW + 2 * 24 * HOUR }], error: "Usage endpoint HTTP 429" });
	runtime.quota.cooldowns = [{ provider: "anthropic", until: NOW + HOUR }, { provider: "openai-codex", until: NOW }];
	return usageReport(runtime, NOW);
}
