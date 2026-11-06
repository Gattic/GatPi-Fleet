// The context report in api/fixtures/context.json: Android tests decode it, host tests check it is current.
import { contextReport } from "../src/server/context.ts";
import { ManagerRuntime } from "../src/manager/runtime.ts";
import { emptyUsage, type ContextBreakdown, type SessionState } from "../src/protocol/index.ts";

const NOW = Date.UTC(2026, 0, 15, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function state(pid: number, cwd: string, context: SessionState["context"], name?: string): SessionState {
	return {
		pid, instanceId: `instance-${pid}`, sessionId: `session-${pid}`, cwd, name,
		phase: "idle", phaseSince: NOW - 60_000, lastEventAt: NOW - 60_000,
		usage: { direct: emptyUsage(), indirect: emptyUsage() },
		usageMinutes: [], tools: [], timeline: [], models: [], asks: [], prompts: [],
		context,
	};
}

const breakdown = (parts: ContextBreakdown["parts"], unattributed: number | null, measured: boolean): ContextBreakdown => ({
	parts, unattributed, totalBasis: measured ? "measured" : "estimate", imageTokens: 0,
	counts: { user: 2, assistant: 3, toolResults: 4, injected: 1, imageBlocks: 0 },
	compactAt: 183_616, history: [166_000], at: NOW - 60_000,
});

export function contextFixture() {
	const runtime = new ManagerRuntime();
	try {
		runtime.store.setState(11, state(11, "/home/user/dev/pi-dash", {
			tokens: 166_000, window: 200_000, percent: 83,
			breakdown: breakdown({ system: 12_000, tools: 14_000, injected: 30_000, user: 6_000, assistant: 16_000, toolResults: 68_000, summary: 2_000 }, 18_000, true),
		}));
		runtime.store.setState(12, state(12, "/home/user/dev/site", {
			tokens: null, window: 200_000, percent: null,
			breakdown: breakdown({ system: 2_000, tools: 3_000, injected: 0, user: 1_000, assistant: 2_000, toolResults: 2_000, summary: 0 }, null, false),
		}, "Site redesign"));
		runtime.store.setState(13, state(13, "/home/user/dev/legacy", {
			tokens: 40_000, window: 200_000, percent: 20,
		}));
		runtime.usage.apply({
			type: "update", scanned: true, durationMs: 0, removed: [], changed: [
				{
					path: "/sessions/ended.jsonl", kind: "session", sessionId: "ended", cwd: "/home/user/dev/site",
					name: "Fix the header", size: 1, mtimeMs: NOW - 2 * HOUR, offset: 1, hours: {},
					context: { tokens: 90_000, at: NOW - 2 * HOUR, model: "anthropic/claude-opus-5-5", peak: 120_000, requests: 8 },
				},
				{
					path: "/sessions/lost.jsonl", kind: "session", sessionId: "lost", cwd: "/home/user/dev/notes",
					firstPrompt: "Draft release notes", size: 1, mtimeMs: NOW - 3 * DAY, offset: 1, hours: {},
				},
			],
		});
		return contextReport(runtime, NOW);
	} finally {
		runtime.close();
	}
}
