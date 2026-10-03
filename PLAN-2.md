# pi-dash — Plan 2: evaluation follow-up

Status: implemented 2026-10-03 (results in §5). Source: a live evaluation of pi-dash against five real sessions at
150×45, 100×30 and 80×24, plus a source read. `PLAN.md` stays the design record; decisions
made here are also recorded there (marked *Updated*) when they are implemented.

## 1. Goal

Fix the visual defects and data blind spots found in the evaluation, and add the features that
shorten the "prompt loop across ~6 sessions" workflow: jump to the next session that needs
you, context fill per row, a tool timeline, compact / model / thinking control, and
background job and subagent badges.

Out of scope (decided in the evaluation): terminal tab-title counts (alerts stay inside the
dashboard, as asked), multi-session broadcast, a multi-turn transcript reader, an LLM
classifier of replies, re-sorting rows by urgency, and colour peek (tmux).

## 2. Findings this plan addresses

| # | Finding | Cause |
|---|---|---|
| F1 | Overview plan cell shows `▰▰▰▰▰▰▰▰▰▱ 92/…` | `selectedSummary` reserves a fixed 16 columns for the bar and count |
| F2 | Usage view prints `anthropic5h` | provider label cell is exactly 9 columns wide |
| F3 | Per-row CPU and API/min sparklines are not comparable between rows | each row is scaled to its own maximum |
| F4 | Detail charts draw a flat 438M as a full block, and CPU noise as spikes | charts scale to their own maximum, no floor |
| F5 | At 80×24 the detail view loses NEXT and the 60m lane | fixed sections overflow; the tail is sliced off |
| F6 | Quota share legend repeats `ProjectA` | per-session shares labelled by project name |
| F7 | About 25 empty rows under a short SAID in the overview | the summary omits PROMPT and NEXT |
| F8 | Sessions on unpriced models (codex#2, gpt-6-sol: ~726M tokens in 30 days) show `—`, vanish from COST BY SESSION, and never get a quota share | everything is cost-based |
| F9 | After a dashboard restart the 60m lane is blank | lane history lives only in the dashboard |
| F10 | After `/resume` or `/reload`, a session waiting on you shows `○ ready` and `TOOLS none yet` | the bridge's startup snapshot sets no `lastSettledAt` and no tools |
| F11 | `seen 1m08s` is dashboard observation time, not session age | uptime derived from the sample count |

## 3. Decisions

- **D1 Protocol v2.** New state fields (`timeline`, `models`) and commands (`compact`, `model`,
  `thinking`) bump `PROTOCOL_VERSION` to 2. No compatibility layer: sessions still running the v1
  bridge show `✖ bridge v1` (resources only) until they restart. The bridge rejects unknown
  commands instead of acknowledging them.
- **D2 Timeline.** The bridge keeps transitions between `working`, `waiting` (idle after a run)
  and `idle` (fresh session) for the last hour, starting no earlier than the pi process. At
  startup it rebuilds them from the session's messages. The dashboard backfills a row's lane
  from it the first time it sees that session's bridge.
- **D3 Resumed sessions.** A session that starts idle with message history is waiting on you:
  `lastSettledAt` is the time of its last message, and the last 20 tool runs are rebuilt from
  the transcript. A reconnect (status `connecting` → anything) no longer raises an alert.
- **D4 Tokens where cost is unknown.** Rows and the detail usage block show tokens when a
  session's cost is 0. The usage view gets a `$` key that switches every panel between cost and
  tokens. Quota shares are weighted by cost, or by tokens for providers with no cost in the window.
- **D5 Shared scales.** Overview sparklines share one scale across rows (CPU with a 1-core
  floor). Detail charts have floors: 1 core, 4 GiB.
- **D6 Keys.** `Tab` jumps to the next session that needs attention (needs you, error, stalled;
  longest waiting first, cycling). `M` model, `T` thinking level, `Z` compact (asks first; idle
  sessions only). Lowercase `t`/`w`/`m` stay the usage view's ranges.
- **D7 Background badges.** The process sampler recognises GatPi-Harness `bg_run` supervisors
  (`managed-job-supervisor.js <job>.launch.json`) and subagents (`pi --mode rpc`) among a
  session's processes, with their names (job name, subagent role) and start times. The overview
  shows `2j 1s` in a BG column at ≥ 120 columns; the summary and detail view list them.
- **D8 Session age** comes from the pi process start time (`/proc` starttime + boot time).

## 4. Phases

Each phase ends green (`npm run check`, `npm test`) with a working dashboard.

### Phase A — Visual fixes (F1–F7)

1. Overview summary: measure the plan bar and count instead of reserving 16 columns.
2. Usage view: size the provider column to the longest provider label plus a space.
3. Overview: CPU sparklines share the maximum across rows (floor 1 core); API/min sparklines share
   the maximum across rows.
4. Detail charts: floor the CPU scale at 1 core and memory at 4 GiB (one constant shared with the
   overview's MEM column).
5. Detail layout by budget: charts 2–5 rows, tool list 1–6 rows, SAID gets the rest (at least 1).
   NEXT and the 60m lane always fit at 80×24.
6. Usage view: one owner label for both panels: open sessions by row label, ended sessions as
   `project › name or first prompt`.
7. Overview summary: add PROMPT, NEXT (and BG from Phase E) around SAID.

Tests: render tests for `92/100`, `anthropic 5h`, distinct legend labels, 80×24 detail with NEXT
and 60m, overview summary with PROMPT and NEXT, shared sparkline scale.

### Phase B — Tokens where cost is unknown (F8)

1. `fmtTokens` drops the decimal at ≥ 100 units (as `fmtCost` does), so `173M` fits a cell.
2. Overview `$` column: `173Mt` (muted) when the session has tokens and no cost.
3. Detail usage block: direct / tools / subagents bars and totals switch to tokens when the
   session's cost is 0.
4. Usage view: `$` toggles cost / tokens for the session list, the per-period chart and BY MODEL;
   the range rule shows the active metric.
5. Quota share weights per D4.

Tests: render tests for an unpriced session (row, detail, usage tokens mode); index test for
token-weighted shares.

### Phase C — Bridge state that survives restarts (F9–F11), protocol v2

1. Protocol: `PROTOCOL_VERSION = 2`; `timeline: TimelineEntry[]`; `models?: string[]`; commands
   `compact`, `model {provider, id}`, `thinking {level}` (implemented in Phase D).
2. Bridge startup: `lastSettledAt` and tool runs from history (D3); timeline from history (D2).
3. Bridge live: timeline entries on every working / waiting change, trimmed to one hour.
4. Store: backfill the lane from the timeline on a row's first bridge state; no alert on
   reconnect.
5. Sampler: process start time for pi processes (D8); detail header shows `up 2h13m`.

Tests: e2e reload asserts `lastSettledAt`, rebuilt tools and the timeline; unit tests for lane
backfill and no alert on reconnect.

### Phase D — Features: attention jump, context column, tool timeline, session control

1. `Tab` jump (D6) in the overview and detail views; footer and help.
2. CTX column (percent coloured by level) in the overview at every width.
3. Detail TOOLS list: newest first, each with status, name, argument summary and duration.
4. Bridge commands: `compact` (idle only; failures surface as `lastError`), `model` (via
   `modelRegistry.find` + `pi.setModel`, error when no auth), `thinking` (`pi.setThinkingLevel`).
   Commands may be async; the ack waits for them. The snapshot carries `models` (scoped models,
   else available ones).
5. Dashboard: `M` model picker (current marked), `T` thinking picker, `Z` compact confirm.

Tests: app tests for Tab cycling, `M`/`T`/`Z` sending the right commands; e2e for model switch,
thinking change, compact, and compact rejected while working (a second scripted model with
reasoning).

### Phase E — Background jobs and subagents (D7)

1. Sampler: classify members of each session as job / subagent with label and start time.
2. Overview BG column (≥ 120 columns), summary BG line, detail BG line.

Tests: attribution test with real processes whose command lines look like a job supervisor and
an RPC subagent.

### Phase F — Docs and verification

1. README: keys, features, the v2 bridge note.
2. PLAN.md: *Updated* notes for protocol v2, timeline, resumed-session state, new keys, badges.
3. Verification: `npm run check`, `npm test`, `npm run test:e2e`; a live run of the new dashboard
   in a private tmux at 150×45, 100×30 and 80×24 against the real sessions; one diff review.
4. Results section below.

## 5. Results

All phases are implemented. Deviations from §4, each for a reason found while building:

- The detail TOOLS list (D3) landed in Phase A, because the layout budget allocates its rows.
- The BG column shows from 140 columns, not 120: at 120 with long session names it squeezed PLAN
  to 18 columns. Narrower terminals list background work under the table and in the detail view.
- Detail charts shrink to one row (not two) before the lane is lost, so an ERROR line still
  leaves NEXT and the 60m lane visible at 80×24.
- Open sessions in the usage view carry their slot (`2 ProjectB`), and BY MODEL merges one
  model reached through several accounts (codex, codex#2).

Found and fixed on the way:

- **Compaction left sessions "working".** pi emits `session_compact` while still compacting, and
  no event follows. A manual `/compact` therefore left the row working until it showed as stalled.
  The bridge now checks `ctx.isIdle()` after the event has been handled (e2e covers it).
- **Incompatible bridges were never retried.** The hub skipped a rejected pid forever. It now
  retries once the socket file is replaced, and verification showed that `/reload` loads changed
  bridge code. So a session moves to protocol v2 with `/reload`, and its row says so
  (`✖ bridge v1: /reload it`).

Verification:

- `npm run check`: clean. `npm test`: 39 tests (12 new or extended: plan width, provider and
  owner labels, shared scales, chart floors, 80×24 layout with and without an error, tokens for
  unpriced models, BG rendering, lane backfill, no alert on reconnect, Tab walk, M/T/Z, hub
  reconnect after `/reload`, job/subagent attribution with real processes).
- `npm run test:e2e`: 14 tests against the real pi, including reload state (`lastSettledAt`,
  rebuilt tool runs, timeline), the models list, model and thinking switches with clamping, and
  compaction (rejected while working, reported failure, a successful run that returns to idle).
- Live: a second pi-dash in a private tmux at 150×45, 100×30 and 80×24 next to the five real
  sessions and one disposable offline pi. Checked the BG badges and names of real `bg_run` jobs,
  the backfilled lane after restarting the dashboard, Tab to the waiting session, model and thinking
  switches, a compaction refusal shown as an error, the usage view in tokens, `up 27s`, and the
  help overlay.

Known, not in this plan's scope: at 120 columns the help overlay cuts its STATES and NOTES lines;
the overview summary repeats an error on its NOW and ERROR lines; costs under half a cent show as
`0.00`.

Rollout: the running pi sessions still have the v1 bridge in memory, and the running pi-dash is
v1. Restart pi-dash first, then type `/reload` in each session (or restart it). Until then those
rows show `✖ bridge v1: /reload it` with resources only.
