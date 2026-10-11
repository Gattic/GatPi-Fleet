import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildHermesSnapshot, deriveLocalCards, HermesAdvisor, normalizeHermesCards } from "../src/dashboard/hermes/advisor.ts";
import { Store } from "../src/manager/model/store.ts";
import { emptyUsage, type SessionState } from "../src/protocol/index.ts";

function session(overrides: Partial<SessionState> = {}): SessionState {
	const now = Date.now();
	return {
		pid: 101,
		cwd: "/home/user/dev/proj",
		sessionId: "s",
		instanceId: "instance",
		phase: "idle",
		phaseSince: now,
		lastEventAt: now,
		usage: { direct: emptyUsage(), indirect: emptyUsage() },
		usageMinutes: [],
		tools: [],
		timeline: [],
		models: [],
		asks: [],
		...overrides,
	};
}

test("Hermes snapshots are redacted and local rules produce action cards", () => {
	const store = new Store(() => {});
	store.setState(
		101,
		session({
			lastPrompt: "SECRET prompt content",
			lastSaid: "SECRET assistant transcript",
			lastSettledAt: Date.now() - 5000,
			lastError: { message: "tests failed", at: Date.now() - 5000 },
			context: { tokens: 180_000, window: 200_000, percent: 90 },
		}),
	);
	const snapshot = buildHermesSnapshot(store);
	const serialized = JSON.stringify(snapshot);
	assert.doesNotMatch(serialized, /SECRET/, "raw prompt/reply text is not sent to Hermes");
	assert.equal(snapshot.sessions[0]?.cwdName, "proj");
	assert.equal(snapshot.sessions[0]?.status.kind, "error");

	const cards = deriveLocalCards(snapshot);
	assert.ok(cards.some((card) => card.action?.kind === "ask" && card.title.includes("error")));
	assert.ok(cards.every((card) => card.source === "local"));
});

test("Hermes card normalization accepts only known sessions and safe actions", () => {
	const store = new Store(() => {});
	store.setState(101, session({ lastSettledAt: Date.now() }));
	// The same pid on a remote host is another session.
	store.setState(101, session({ lastSettledAt: Date.now(), cwd: "/home/user/other" }), "box03");
	const snapshot = buildHermesSnapshot(store);
	assert.deepEqual(snapshot.sessions.map((entry) => [entry.session, entry.label]).sort(), [["101", "proj"], ["box03:101", "other@box03"]]);
	const cards = normalizeHermesCards(
		{
			cards: [
				{ id: "ok", severity: "critical", title: "Ask", body: "Ask it", targetSession: "box03:101", evidence: ["waiting"], action: { kind: "ask", session: "box03:101", question: "Why?" } },
				{ id: "bad", title: "Unknown", body: "No", action: { kind: "compact", session: "999" } },
				{ id: "pid", title: "Pid only", body: "No", action: { kind: "compact", session: 101 } },
			],
		},
		snapshot,
	);
	assert.equal(cards.length, 3);
	assert.equal(cards[0]?.source, "hermes");
	assert.deepEqual(cards[0]?.action, { kind: "ask", session: "box03:101", question: "Why?" });
	assert.equal(cards[0]?.targetLabel, "other@box03");
	assert.equal(cards[1]?.action, undefined, "unknown sessions are not executable");
	assert.equal(cards[2]?.action, undefined, "a bare pid is ambiguous across hosts");
});

test("Hermes feedback ledger is summarized into later local reviews", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-dash-hermes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const advisor = new HermesAdvisor({ ledgerPath: join(root, "events.jsonl"), command: "" });
	await advisor.recordFeedback({ kind: "dismissed", cardId: "c1", cardTitle: "Noisy card", source: "local", actionKind: "notify" });
	const store = new Store(() => {});
	store.setState(101, session({ lastSettledAt: Date.now() }));
	const review = await advisor.review(buildHermesSnapshot(store));
	assert.equal(review.source, "local");
	assert.ok(review.feedbackSummary.some((line) => line.includes("dismissed notify: Noisy card")));
});
