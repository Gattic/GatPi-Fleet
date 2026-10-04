# pi-dash — Plan 4: Hermes advisor and self-learning management loop

Status: implemented, 2026-10-04. This plan turns the Hermes integration brainstorm into a bounded implementation. It keeps `PLAN.md` as the overall design record and extends pi-dash without changing the bridge protocol.

## 1. Goal

Add a Hermes-backed advisor to pi-dash that helps manage running pi sessions from the dashboard. The advisor should inspect a redacted dashboard snapshot, propose typed action cards, let the operator confirm or dismiss each proposal, and persist feedback so Hermes and pi-dash can learn which management advice is useful.

The first complete version is intentionally dashboard-local:

- no autonomous actions;
- no raw transcript exposure;
- no bridge protocol changes;
- no direct imports from Hermes internals;
- no writes to Hermes memory without explicit review.

## 2. Requirements from the brainstorm

1. **Integration boundary.** Pi core/extensions must consume cognitive functionality through a narrow adapter, not scattered internal imports.
2. **Read-only by default.** Hermes sees session summaries and metrics, not full transcripts or tool output, unless a later explicit feature expands scope.
3. **Typed action cards.** Hermes proposes bounded actions that pi-dash can already perform: ask, prompt, compact, notify, or record a memory/skill proposal.
4. **Human confirmation.** Any mutating or interruptive action is confirmed by the operator in pi-dash before execution.
5. **Self-learning loop.** pi-dash records shown, accepted, executed, dismissed, and failed cards in a local ledger. The next Hermes request includes a compact feedback summary.
6. **Graceful availability.** The dashboard must remain usable if the Hermes CLI is unavailable or returns invalid output; deterministic local rules still produce useful cards.

## 3. Architecture

```
Store / Usage / Quota / GPU
        │
        ▼
redacted HermesSnapshot ──► HermesAdvisor adapter ──► Hermes CLI -z JSON review
        │                         │
        │                         ├─ validates/normalizes cards
        │                         ├─ falls back to deterministic local cards
        │                         └─ appends feedback JSONL
        ▼
HermesAdvice overlay (H)
        │
        ├─ Enter: confirm + execute typed action through existing App/Bridge commands
        ├─ d: dismiss + ledger event
        └─ r: refresh advisor with latest snapshot and feedback summary
```

### Files

- `src/dashboard/hermes/advisor.ts` — adapter, snapshot building, CLI invocation, card validation, local rules, feedback ledger.
- `src/dashboard/ui/overlays.ts` — `HermesAdviceView` overlay.
- `src/dashboard/ui/app.ts` — `H` key, action execution, feedback recording.
- `src/dashboard/main.ts` — instantiate the advisor with a cache-backed ledger path.
- `README.md` — document the advisor, safety boundary, keys, and feedback storage.
- `test/hermes.test.ts` / `test/app.test.ts` — advisor and UI behavior.

## 4. Phases

Each phase ends with a working dashboard.

### Phase A — Advisor model and adapter

1. Define `HermesSnapshot`, `HermesAdviceCard`, `HermesCardAction`, and feedback-event types.
2. Build redacted snapshots from dashboard state: row label, cwd basename, status, timers, activity kind/tool name, context percent, plan title/active path, usage totals, resource totals, current suggestion, and last error. Exclude `lastSaid`, ask answers, raw transcripts, and full tool output.
3. Add deterministic local cards for obvious states: stalled, error, rate-limited, high context, needs-you with suggestion, and all-clear.
4. Add an adapter that optionally calls `hermes -z` with a strict JSON schema and timeout, validates its response, merges/limits cards, and falls back to local cards on failure.
5. Append feedback events as JSONL under the dashboard cache directory.

### Phase B — TUI cooperation loop

1. Add `H` to overview/detail key hints and help.
2. Add a `HermesAdviceView` overlay with cards, status, source, navigation, refresh, dismiss, and execute keys.
3. Execute card actions only through existing dashboard commands:
   - `ask` → bridge `{ kind: "ask" }`;
   - `prompt` → bridge `{ kind: "prompt" }` with steer/follow-up when needed;
   - `compact` → bridge `{ kind: "compact" }`;
   - `notify`, `memory_proposal`, and `skill_proposal` → dashboard-visible records only.
4. Confirm every mutating action before dispatch.
5. Record `shown`, `dismissed`, `accepted`, `executed`, and `failed` outcomes.

### Phase C — Documentation and verification

1. Document the feature and safety boundary in `README.md`.
2. Mark this plan implemented with deviations and verification evidence.
3. Run `npm run check` and focused tests, then review the diff.

## 5. Non-goals

- Autonomous Hermes control of sessions.
- A long-running Hermes sidecar or MCP server.
- Durable writes into Hermes memory or skill stores.
- Transcript export to Hermes.
- A new bridge protocol version.

## 6. Rollout

This is dashboard-only. Existing pi sessions do not need `/reload`; the bridge is unchanged. Restart pi-dash to use the new `H` advisor view.

## 7. Results

Implemented all phases.

- Added a dashboard-local Hermes adapter with redacted snapshots, strict card normalization, deterministic local cards, optional `hermes -z` refinement, and a JSONL feedback ledger.
- Added the `H` Hermes advisor overlay with refresh, navigation, dismiss, and confirmed execution for ask / prompt / compact / notify / memory-proposal / skill-proposal cards.
- Documented the feature, safety boundary, optional Hermes dependency, and feedback-ledger path in `README.md`.
- Tests added for snapshot redaction, local cards, card normalization, feedback summaries, and the TUI confirmation path.

Verification:

- `npm run check`: clean.
- `npm test`: passed.
