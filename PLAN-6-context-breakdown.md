# pi-dash — Plan 6: per-session context breakdown and cumulative view

Status: **implemented**. The terminal dashboard shipped in `7d6893e`; the gateway context
endpoint and Android context view are implemented on `feat/android-context-breakdown`. Written
against pi-dash at `aef6e55` and the local pi checkout (`getContextUsage` / `estimateTokens`
semantics cited below).

## 1. Goal and definitions

pi-dash already shows **how full** a session's context window is: one gauge and a percentage.
It does not show **what** fills it. This plan adds two surfaces:

1. **Per-session context breakdown** — for each open session, the composition of the context
   the next request will carry: system prompt, tool schemas, extension-injected context,
   user/assistant text, tool results, compaction summaries, images, and an unattributed
   residual. Measured against the model's context window and the compaction threshold.
2. **Cumulative breakdown across sessions** — a separate, explicitly labelled aggregate over
   all sessions in scope: total resident context tokens, weighted mean fill, category totals
   and shares, counts of sessions near compaction, and per-host/per-model splits.

The word *breakdown* means **composition**, not spend. Spend per session is already covered by
the `u` usage view (`src/dashboard/ui/views/usage.ts`); this plan deliberately does not duplicate
it. The two views answer different questions: "what did these sessions cost" versus "what is
sitting in these windows right now".

### 1.1 Categories

| Category | Contents |
|---|---|
| `system` | `ctx.getSystemPrompt()` — pi's rendered system prompt, including its sections |
| `tools` | The active tool set declared to the model (`pi.getAllTools()` ∩ `pi.getActiveTools()`), by schema size |
| `injected` | `custom_message` entries (extension-injected context, e.g. cognitive-automation blocks). Model-visible: they project to role `custom` |
| `user` | User messages (text and images) |
| `assistant` | Assistant text, thinking and tool-call arguments |
| `toolResults` | Tool results, including bash-execution output |
| `summary` | `compaction` / `branch_summary` summaries carried in the projection |
| `imageTokens` | Image blocks, reported separately for visibility. They are **already counted** inside their owning category (user, toolResults), so this figure is informational and is never added to the parts sum |
| `unattributed` | `measured − Σ parts` when positive; a negative residual is reported as estimation error, never clamped into a fake category |

### 1.2 Honesty rules (non-negotiable)

- The **total** is pi's own measurement: `ctx.getContextUsage()` → last assistant `usage.totalTokens`
  plus pi's own trailing estimate (`estimateProjectedContextTokens` in
  `packages/coding-agent/src/core/compaction/compaction.ts`). It is labelled *measured*.
- The **parts** are always estimates and are labelled as such. They are produced with pi's own
  `estimateTokens` (chars/4, the same estimator `getContextUsage` uses for trailing messages).
  That does not make them exact: the measured total comes from the provider's `usage` for the last
  request, while every part is a chars/4 estimate, so `unattributed` can be a meaningful share and
  can be negative. Show it as a real residual; never rescale the parts into false exactness.
- **Unknown is not zero.** After a compaction, before the next model response, pi returns
  `tokens: null, percent: null`. Show "context unknown until the next response", not 0%.
- Summing independent windows is **not** a shared budget. The cumulative view reports
  `Σ tokens`, `Σ windows` and a *window-weighted mean fill*, never "one budget 37% used".
- Ended sessions have no composition until their file is reconstructed (§4.4); show fill only and
  say so. Never infer system prompt or tool schemas for an ended session.
- No transcript, tool output or prompt text is added to the protocol, gateway or Android by this
  plan. Only counts and timestamps.

## 2. What exists today

| Evidence | What we reuse / must account for |
|---|---|
| [`src/protocol/index.ts`](src/protocol/index.ts) line 210 | `SessionState.context` is already `{ tokens, window, percent }`, carried by snapshot and patch, and mirrored over the relay to remote hosts. |
| [`src/bridge/index.ts`](src/bridge/index.ts) line 321 `refreshContext()` | Calls `ctx.getContextUsage()` on `turn_end`, `agent_settled`, `session_compact`, `session_tree` and `after_provider_response`; publishes with `set({ context })`. This is the natural hook for the breakdown. |
| [`src/bridge/index.ts`](src/bridge/index.ts) line 367 `activeTools()`, line 399 `ctx.getSystemPrompt()` | Already used to rebuild the exact request prefix for side questions; the same inputs give system and tool sizes. |
| `@earendil-works/pi-coding-agent` | Runtime exports `buildSessionContext`, `estimateTokens`, and `ExtensionContext.getContextUsage()` / `getSystemPrompt()`. The bridge already imports from this package, so no new runtime dependency is needed. |
| `packages/coding-agent/src/core/compaction/compaction.ts` | `estimateTokens` is chars/4 and handles `system` (`toolsAdded`), `custom`, `toolResult`, `compactionSummary`, `branchSummary` and `bashExecution`; `shouldCompact` uses `window - reserveTokens` (`DEFAULT_COMPACTION_SETTINGS.reserveTokens = 16384`). |
| `packages/ai/src/utils/estimate.ts` | A second estimator (chars/3.5) exists in pi-ai for bug reports/transcripts. It must **not** be used here, or the parts will not reconcile with `getContextUsage`. |
| [`src/manager/usage/extract.ts`](src/manager/usage/extract.ts) line 68 | `UsageRecord.prompt` already computes `input + cacheRead + cacheWrite` per assistant message — the measured context size of that request. |
| [`src/manager/usage/indexer.ts`](src/manager/usage/indexer.ts) | Incremental byte-level JSONL scanner, worker thread, `CACHE_VERSION = 1`, 30-day retention, hourly buckets. It currently aggregates `prompt` into buckets and discards the latest value. |
| [`src/dashboard/ui/views/detail.ts`](src/dashboard/ui/views/detail.ts) line 111, [`overview.ts`](src/dashboard/ui/views/overview.ts) line 110 | Only the ctx gauge is rendered; the detail view is already dense (fixed sections + charts + tools + SAID). |
| [`src/server/sessions.ts`](src/server/sessions.ts) | The gateway now projects `context` (tokens, window, percent, optional breakdown) in selected detail; Android decodes and renders it. |
| [`docs/API.md`](docs/API.md) | The gateway shape change is additive: `GET /api/v1/context`, a `context` capability and optional `context` in detail; fixtures, both clients and docs updated without a version bump. |

Local scale to design for: `~/.pi/agent/sessions` is ~9.2 GB; the largest single session file is
~500 MB. Live composition is cheap because the bridge holds the session in memory; reconstructing
an ended file is not (§4.4).

## 3. Data model

### 3.1 Live breakdown (bridge → protocol)

Extend the existing `context` object additively. `parts` is optional, so an older dashboard keeps
rendering `percent` and a newer dashboard degrades cleanly against an older bridge (a session
started before the update). **No protocol version bump**: the change is additive, `applyPatch`
handles the whole-object replacement, and forcing `/reload` on every session would be a needless
interruption.

Keep one object and one source of truth: the existing `context` gains optional fields. Its current
`tokens`/`window`/`percent` are unchanged, so today's gauge and the gateway projection keep working.

```ts
export interface ContextParts {
	system: number;
	tools: number;
	injected: number;
	user: number;
	assistant: number;
	toolResults: number;
	summary: number;
}

/** Added to SessionState.context; every field is optional so an older bridge still parses. */
export interface ContextBreakdownFields {
	/** Estimated parts; Σ parts + unattributed reconciles with `tokens` when it is known. */
	parts: ContextParts;
	/** measured − Σ parts; negative means the estimate overshoots the measurement. */
	unattributed: number;
	/** Image tokens, already included in their owning category; informational, not part of Σ parts. */
	imageTokens: number;
	/** Whether `tokens` came from pi or is only an estimate of the projection. */
	basis: "measured" | "estimate";
	/** Conversation shape, for "why is it big" (counts only). */
	counts: { user: number; assistant: number; toolResults: number; injected: number; images: number };
	/** window − reserveTokens from `pi.getSettings().compaction`; null when compaction is disabled. */
	compactAt: number | null;
	/** Prompt tokens of the last N requests, oldest first (N ≤ 32). */
	history: number[];
	at: number;
}

export interface SessionContext {
	tokens: number | null;
	window: number;
	percent: number | null;
	breakdown?: ContextBreakdownFields;
}
```

The payload is bounded: fixed parts, ≤ 32 history numbers, no strings. Worst case is a few hundred
bytes per session per turn.

### 3.2 How the bridge computes it

Recompute on the same hooks as `refreshContext()`, cached by
`(sessionId, leafId, entryCount, model, captured system message, active-tool set)` so a repeated
call is free:

1. `buildSessionContext(entries, leafId).messages` → the current conversation projection, which
   includes trailing messages the next request will carry.
2. Capture the request's leading system message in `pi.on("context_with_system")`: the event's
   `messages[0]` is the exact prompt plus `toolsAdded` that the provider receives (installed
   `pi-coding-agent` 1.0.0 emits it before every LLM call). Store the message reference only; the
   handler runs before the request and must stay O(1) and return undefined. Before the first
   request, fall back to a synthetic message built from `ctx.getSystemPrompt()` + `activeTools()`.
3. `estimateTokens` on that system message gives `system + tools` together; split them by estimating
   the text content alone and the `toolsAdded` JSON alone, and check the sum against the combined
   value.
4. `estimateTokens` per projected message, bucketed by role:
   `custom → injected`, `user → user`, `assistant → assistant`, `toolResult → toolResults`,
   `compactionSummary|branchSummary → summary`, `bashExecution → toolResults`.
5. Count image blocks while walking and report their estimated tokens (4800 chars each, matching
   pi's estimator) as `imageTokens`. They stay inside their owning category in `parts`, so
   `imageTokens` is never added to the parts sum.
6. `unattributed = tokens − Σ parts` when `tokens` is known.
7. `history`: iterate `ctx.sessionManager.getEntries()` (not the projection, which drops compacted
   history) and record `calculateContextTokens(message.usage)` per assistant message, newest 32.
   That is the value `getContextUsage` trusts; `prompt` alone would omit the response's output.

Phase 0 measures the recompute cost on the largest locally open session. `estimateTokens` is
O(messages) per call plus a `JSON.stringify` per tool call; if p95 exceeds ~20 ms, add incremental
accounting (append-only cursor, full recompute only on compaction/tree/context-edit or model/tool
change). Do not add that machinery before it is measured.

### 3.3 Indexed breakdown (ended sessions)

Cheap, latest-only additions to `FileUsage` — no per-message content is retained:

```ts
/** Latest measured request context, from the newest assistant usage in the file. */
context?: { tokens: number; at: number; model: string; peak: number; requests: number };
```

`extract.ts` already sees every assistant usage; the indexer keeps the last record's `prompt`,
model, timestamp, a running `peak`, and a request count. `CACHE_VERSION` becomes 2; the old cache
is discarded and rebuilt by the existing worker scan (one-time cost, off the main thread, already
the behaviour on cache loss). No composition is stored for ended files.

### 3.4 Context window for indexed sessions

`context` alone is meaningless without a window. Add `src/manager/context/windows.ts`: a cached,
synchronous `ModelRuntime.getModel(provider, id)?.contextWindow` lookup. Do **not** reuse the runtime
[`oauth-renewal.ts`](src/manager/collectors/oauth-renewal.ts) creates: it passes `modelsPath: null`,
so it holds built-in models only and cannot resolve `~/.pi/agent/models.json` custom/virtual models
or extension-registered aliases. Create a separate read-only runtime with the real models path and
`refreshOnCreate: false`, `allowModelNetwork: false` (verify in Phase 0 that it performs no network
I/O). Unknown model → `window: null`, `percent: null`. Never substitute 128k.

## 4. Surfaces

### 4.1 Detail view block (per session)

Insert one compact block after the header rule, before the existing usage section:

```
CTX   ██████░░░░ 84k / 450k  19%   compacts at 434k (350k headroom)
      system 8%  tools 9%  injected 21%  user 4%  assistant 11%  toolResults 46%  summary 1%
      unattributed +18k (21%) · 12 user · 31 assistant · 28 tool results · 4 injected · 2 images
```

Rules:
- Bar segments use the existing `hbar`/`stackedArea` helpers and a fixed category order; the legend
  names only non-zero categories so narrow terminals stay readable.
- `tokens: null` → `CTX ░░░░░░ unknown until the next response` plus the estimate parts labelled
  `estimate`.
- No breakdown (older bridge) → keep today's gauge and add `breakdown needs /reload`.
- Never let this block push the SAID pane off screen: it is fixed-height (≤ 4 rows) and participates
  in the existing `spare` budget in `renderDetail`.

### 4.2 New `context` view (per session + cumulative)

A fifth tab, key **`K`** (unused in every view), listed in `KEYS` and reachable from overview and
detail. Layout mirrors the usage view's two-column shape:

```
CONTEXT   open 12 · Σ 1.42M across 8.6M window tokens · weighted mean fill 17%
          ▇▇▂▁▁▁▁▁ system · tools · injected · user · assistant · toolResults · summary
──────────────────────────────────────────────────────────────────────────────────────────
BY SESSION                                    CTX     WINDOW   FILL   COMPACT AT
 1 alpha        ▇▇▂▁▁▁▁▁▁             84k     450k     19%    434k
 2 beta         ▇▇▇▇▂▁▁▁▁            312k     200k    156%    —  ⚠
 3 gamma        ░ unknown             —       128k      —     112k
...
──────────────────────────────────────────────────────────────────────────────────────────
CUMULATIVE (open sessions)
  system        3%
  tools         9%
  injected     21%
  user          4%
  assistant    11%
  toolResults   46%
  summary       1%
  unattributed  2%
  Σ 1.42M tokens · weighted mean fill 17% · 3 sessions ≥ 80% · 1 unknown · 2 unbridged
  2 image blocks (0.2%) included in the categories above
BY HOST  this machine 1.1M · lab 320k        BY MODEL  opus 900k (4) · codex 520k (8)
```

- Left column is the per-session breakdown, largest first, with the open-session label from
  `rowLabel` and the ended-session title from `sessionTitle` (`src/manager/usage/report.ts`).
- Rows with `percent ≥ 80` are highlighted; a window overrun (`percent > 100`) is shown as an error,
  not silently clamped.
- Rows without a bridge or without breakdown data are shown, never dropped, with an explicit mark.
- Right column is the **cumulative** breakdown (§4.3). On narrow terminals the columns collapse to
  the session list plus a three-line summary, matching the usage view's existing behaviour.
- Keys: `Esc` back, `a` cycles scope, `j/k`/`PgUp/PgDn` scroll when the list exceeds the screen,
  `⏎` opens that session's detail (where §4.1 shows the full block), `?` help.

### 4.3 Cumulative breakdown semantics

Scope selector (`a`):

| Scope | Sessions counted | Composition total | Label |
|---|---|---|---|
| `open` (default) | Every bridged session, this machine and remote hosts | Σ measured context, parts summed | "CUMULATIVE (open sessions)" |
| `today` | Open plus sessions active since local midnight | Open composition + Σ last-known context of ended ones | "… open + ended today (ended: fill only)" |
| `30d` | Everything retained by the usage index | same, ended rows excluded from parts | "… retained 30 days" |

- The **composition total** always covers sessions with live breakdowns only. Ended sessions
  contribute `Σ last-known tokens` in a separate line, labelled as a last-known figure, never mixed
  into parts.
- `weighted mean fill = Σ tokens / Σ windows` over sessions that have both values. It is described
  as a weighted mean, not a budget.
- Counts: sessions ≥ 80% (near compaction), unknown context, unbridged sessions.
- `BY HOST` reuses `hostUsage`'s ordering (this machine first, then `hosts.json` order) and the same
  freshness marks as the usage view (`…` indexing, `✖` offline keeps what it reported).
- `BY MODEL` counts one model reached through several accounts/hosts once, like `rankedModels`.

### 4.4 Ended-session composition (optional, bounded)

Reconstructing composition for an ended session requires the real projection (compaction cuts and
context edits), not a byte-share heuristic — a heuristic over the whole file would attribute
compacted-away history to the current context, which is exactly the kind of invented number this
project avoids. Options:

- **v1 (recommended): none.** Ended sessions show `last context / window / fill` from §3.3 and
  "composition unavailable for ended sessions".
- **Optional follow-up:** on demand, for a *selected local* ended session only, load its file
  through pi's `SessionManager`/`buildSessionContext` and run the same §3.2 computation. Guard with a
  size cap (proposal: 50 MB, refuse above with an explanation), a spinner and a one-shot cache keyed
  by `(path, size, mtime)`. Remote ended sessions stay fill-only until a relay request exists.

## 5. Phases and acceptance gates

Each phase leaves a working dashboard.

| Phase | Scope | Acceptance gate | Effort |
|---|---|---|---|
| **0 — Baseline** | Confirm on installed `pi-coding-agent` 1.0.0: `context_with_system` fires per request and its `messages[0]` carries prompt + `toolsAdded`; `pi.getSettings().compaction` resolves; `getContextUsage()` cost and its `undefined` vs `{tokens:null}` cases; a separate read-only `ModelRuntime` resolves `models.json` windows without network I/O. Measure §3.2 recompute cost on the largest locally open session. | Recorded findings for R1–R10 in §12 and a decision on incremental/lazy computation (add only if p95 > 20 ms). No product code. | 0.5–1 d |
| **1 — Bridge + protocol** | `ContextParts`/`ContextBreakdownFields` types, §3.2 computation, publish with `context.breakdown`, bounded history, degrade when unsupported. | `npm run check`; new estimator tests pin chars/4 parity with `estimateTokens`; protocol patch/snapshot tests; an old-shaped `context` still renders. | 1–1.5 d |
| **2 — Detail block** | §4.1, fixed-height, inside the existing `spare` budget. | Render tests for measured, null-after-compaction, estimate-only, no-breakdown and narrow widths; no SAID regression. | 0.5–1 d |
| **3 — Context view + cumulative** | §4.2/§4.3, `K` key, scope toggle, host/model splits, README keys. | Render fixtures with 0/1/many sessions, remote hosts, unbridged and unknown rows; cumulative totals match a hand-computed fixture; `docs`/README updated. | 1–1.5 d |
| **4 — Indexer + ended sessions** | §3.3 fields, `CACHE_VERSION = 2`, §3.4 window lookup, ended rows fill-only. | Extractor keeps latest/peak/model/requests; incremental scan still appends correctly and survives rewrites; cache rebuild completes in the worker; unknown model → null. | 1–1.5 d |
| **5 — Gateway + Android** | **Implemented:** breakdown in selected detail, `GET /api/v1/context`, fixture, Kotlin decode + Context tab and detail card; `contextPercent` kept for overview. | Schema snapshot + fixture generated through the real projection; Android JVM decode tests; host tests; docs updated; API version decision recorded. | 2–3 d |
| **6 — Docs and close-out** | README section, claim limits, one focused diff review. | `npm run check`, `npm test`, `npm run test:e2e`; no unlabelled estimate or invented zero anywhere in the UI. | 0.5 d |

TUI scope (phases 0–4, 6): roughly **4.5–6.5 engineering days**. Android parity adds **2–3 days** and
is not required for the request as stated.

## 6. Verification plan

- **Unit**: estimator parity (system + tools + each message role), reconciliation rules
  (`unattributed` positive/negative, measured vs estimate), history ring bound, cache invalidation by
  `(leaf, entries, model, prompt, tools)`.
- **Protocol**: snapshot and patch round-trip with and without `breakdown`; `diffState`/`applyPatch`
  preserve the object; an old dashboard fixture still reads `percent`.
- **Render**: `test/render.test.ts` style fixtures for every state in §4.1/§4.2, including
  `tokens: null`, `window: null`, `percent > 100`, unbridged rows and remote-host freshness marks.
- **Indexer**: extend `test/usage.test.ts` with latest/peak/model/request assertions, a rewrite case
  (offset invalidated), and a v1 cache file that must be discarded rather than misread.
- **Remote**: relay test that a host's `context` with `breakdown` reaches the dashboard and a host
  without it renders degraded.
- **Repository gates**: `npm run check`, `npm test`, `npm run test:e2e` (the bridge changes are
  additive, but the e2e path exercises a real pi session and should still run).

## 7. Performance and bounds

- Recompute only on the existing `refreshContext()` hooks; coalesce through the existing 250 ms
  `flush` timer. No per-token or per-event work.
- Cache the computation by the identity tuple in §3.2 so repeated renders cost nothing.
- History ≤ 32 numbers; parts fixed; payload bounded. Relay deltas stay small.
- Indexer: at most ~6 numbers per file added; no content retained; worker thread only; one-time
  cache rebuild after the version bump.
- Ended-session reconstruction (if adopted): local, on demand, 50 MB cap, cached by size+mtime.

## 8. Risks and claim limits

- **Estimator drift.** The parts mirror pi's chars/4 rule. A pi upgrade that changes estimation
  would silently skew shares; pin parity in a test and revisit when the pi peer version changes.
- **Measured total after compaction.** pi deliberately reports `null` until the next response;
  the UI must not fill that gap with an estimate presented as measurement.
- **Tool-schema size.** `activeTools()` reflects the tool set the bridge sees; extensions that
  change the loadout per request could make the estimate differ from the exact request. Label as
  estimate.
- **Summing windows.** Any "total context" figure is a resident-footprint figure; it is not a
  shared budget and must be worded that way.
- **Ended sessions.** No composition without reconstruction; a byte-share heuristic would be
  invented data.
- **Old bridges.** Sessions started before the update show fill only until `/reload`; the UI must say
  so rather than render an empty breakdown.
- **Disk.** The plan reads no new data and stores only small counters. It does not add retention
  pressure to the ~9.2 GB session tree; the index cache stays well under 1 MB at current scale.

## 9. Decisions to confirm before implementation

1. **Surface**: a new `K` context tab (recommended) versus folding the breakdown into the existing
   `u` usage view.
2. **Cumulative default scope**: open sessions only (recommended), with `today`/`30d` opt-in, or
   default to `today`.
3. **Ended sessions**: fill-only in v1 (recommended) versus the bounded on-demand reconstruction in
   §4.4.
4. **Android**: include phase 5 now, or treat it as follow-on parity (recommended).
5. **Injected context as a first-class category**: recommended yes — extension-injected blocks are
   often the largest *avoidable* share of a session's context, which is precisely what this view is
   for.
6. **Window source for ended sessions**: a separate read-only `ModelRuntime` with the real models
   path (recommended) versus accepting null for models it cannot resolve.
7. **Reconciliation display**: show `unattributed` as a real residual (recommended), or apportion
   the measured total across the estimated parts and label every part as derived.

## 10. Non-goals

- No exact tokenizer (tiktoken/Anthropic counts); pi's estimator is the reference.
- No transcript, prompt text, tool output or credential exposure in the protocol, gateway or Android.
- No prediction of compaction outcomes or of the next request's exact size.
- No cross-session "budget" arithmetic presented as a quota.
- No change to usage/spend semantics, quota collection, or command surfaces.

## 11. Evidence and claim limits

This plan is grounded in the current pi-dash and pi sources cited above. Nothing here was executed:
no bridge change, estimator run, render fixture, gateway projection or Android build exists yet, and
the effort estimates are proposals, not measurements. Phase 0 exists specifically to replace the
assumptions in §3.2 and §3.4 with measured behaviour on the installed pi version before code is
written.

## 12. Review against the installed bridge APIs

Checked against both copies the bridge can resolve: `@earendil-works/pi-coding-agent` **1.0.0** in
`node_modules` and the **1.4.0** checkout in `../pi` (the installed `pi` binary is 1.4.0, so the
runtime copy is not fixed). Every API below behaves the same in both. Verified in `dist/*.d.ts` /
`dist/core/*.js` and in the 1.4.0 sources.

### 12.1 Confirmed usable

| API | Verified behaviour |
|---|---|
| `ctx.getContextUsage()` | Returns `{ tokens, contextWindow, percent }`. `undefined` when there is no model or `contextWindow <= 0`; `{ tokens: null, percent: null }` after a compaction with no post-compaction usage. Internally builds `buildSessionProjection()` and calls `estimateProjectedContextTokens` (last provider `usage.totalTokens` + chars/4 trailing estimate). |
| `ctx.getSystemPrompt()` | Rendered string (`getSystemPrompt: () => this.systemPrompt`). |
| `pi.getAllTools()` / `pi.getActiveTools()` | `ToolInfo[]` (name, description, parameters, promptGuidelines, `exposure`, namespace, annotations, sourceInfo) and `string[]`, documented as the set declared to the model. |
| `pi.getSettings()` | Wired at runtime (`runner.js` → `settingsManager.getSettings()`); merged `Settings` with `compaction?: CompactionSettings` (`enabled`, `reserveTokens`, `keepRecentTokens`). |
| Package root exports | `estimateTokens` (chars/4, `ESTIMATED_IMAGE_CHARS = 4800`; handles `system`+`toolsAdded`, `custom`, `toolResult`, `bashExecution`, `branchSummary`, `compactionSummary`), `calculateContextTokens`, `DEFAULT_COMPACTION_SETTINGS`, `buildSessionContext`, `buildSessionProjection`, `estimateProjectedContextTokens`, `getLastAssistantUsage`. |
| `pi.on("context_with_system")` | Fires before every LLM call with the full transcript including the leading system message (prompt + `toolsAdded`). A handler may return a new list; returning nothing leaves the request unchanged. |

### 12.2 Findings

**R1 — Unimplementable as written: `compactAt` source.** §3.1 said the threshold came "from the
session's compaction settings", but `ExtensionContext` exposes no settings. `pi.getSettings()` does.
*Fix:* `window − (settings.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens)`;
`compactAt: null` when `compaction.enabled === false`. Applied inline.

**R2 — Unimplementable as written: window lookup for ended sessions.** §3.4 reused "the pi runtime
the dashboard already loads", but [`oauth-renewal.ts`](src/manager/collectors/oauth-renewal.ts)
creates `ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })`. With
`modelsPath: null` that runtime holds the built-in catalog only: it cannot resolve
`~/.pi/agent/models.json` custom/virtual models or extension-registered aliases.
*Fix:* create a separate read-only runtime with the real models path, `refreshOnCreate: false`,
`allowModelNetwork: false`, and use synchronous `getModel(provider, id)`. Unknown model → null.
Phase 0 verifies it performs no network I/O. Applied inline.

**R3 — Wrong source: `history`.** §3.2 seeded history from the projection, which drops compacted
history, and from `prompt`, which excludes the response's output.
*Fix:* iterate `sessionManager.getEntries()` and record `calculateContextTokens(message.usage)` per
assistant message, newest 32. Applied inline.

**R4 — Over-promised reconciliation.** The example `unattributed +1.2k` implied tight agreement.
Measured is the provider's `usage.totalTokens` for the last request (input + output + cache read +
cache write) plus pi's chars/4 trailing estimate; parts are chars/4 estimates over the transcript.
The residual can be tens of percent and can be negative.
*Fix:* §1.2 and the §4.1 example now state this; decision 7 chooses residual vs. apportioning.
Applied inline.

**R5 — Missing: snapshot path.** `initialState` ([`src/bridge/index.ts`](src/bridge/index.ts) line
220) sets `context` from `getContextUsage()` only, so a new session's first snapshot would carry no
breakdown. Compute the breakdown there too, not only in `refreshContext()`.

**R6 — Missing: model switch staleness.** `pi.on("model_select")` (line 616) only sets the model
name; it does not call `refreshContext()`. Window, system prompt and tools therefore stay stale until
the next turn. Call `refreshContext()` and drop the captured system message on `model_select`.

**R7 — Ambiguous: two "no data" states.** `getContextUsage()` returns `undefined` when there is no
model or window, and `{ tokens: null }` after compaction. The plan only described the latter. The UI
must distinguish "no context data at all" (hide, as today) from "unknown until the next response".

**R8 — Ambiguous: `basis`.** `basis: "measured" | "estimate"` conflates the total with the parts;
parts are always estimates. Rename to `totalBasis`, or drop it and derive from `tokens === null`.

**R9 — Approximation: reconstructed system/tools.** `getSystemPrompt()` + `activeTools()` may differ
from the exact request: deferred/codemode exposure, per-provider shaping, and later
`context_with_system` handlers that rewrite the transcript after ours. Capturing
`context_with_system` removes most of this; keep the reconstruction only as the pre-first-request
fallback and still label the result an estimate.

**R10 — Cost: double projection.** `getContextUsage()` builds a projection internally, and computing
parts builds another, so each refresh does two projections plus two estimate passes on large
sessions. Phase 0 measures it; if p95 exceeds ~20 ms, compute parts lazily (on dashboard request, or
only while a client needs them) instead of on every refresh.

**R11 — Missing: remote bridge updates.** Remote sessions run the bridge on the remote host. The
relay forwards `SessionState`/`SessionPatch` unchanged, so no `RELAY_VERSION` bump is needed, but a
host whose pi-dash is not updated publishes no breakdown. State the host-update requirement and
degrade visibly per host, like the usage view's `…`/`✖` marks.

**R12 — Missing: model identity.** "BY MODEL" mixes `bridge.model` (the selected model, possibly a
virtual/routed model) with the usage index's physical model keys. Label the selected model and keep
virtual models distinct, or group by the resolved physical model where available.

**R13 — Missing: detail row budget.** The block's height is not specified against `renderDetail`'s
fixed sections and `spare` math. Give it a fixed budget (≤ 4 rows), allocate before charts/tools/SAID,
and fall back to one summary line on short terminals.

**R14 — Missing: key wiring.** `K` must be added to `KEYS`, help, `handleInput` and overlay
dismissal; confirm no overlay already consumes it.

**R15 — Missing: settings cache.** `pi.getSettings()` returns a copy per call and 1.0.0 has no
settings-change event. Cache it per turn (or a short TTL) and refresh on `session_start`,
`model_select` and `session_compact`.

**R16 — Missing: e2e coverage.** No test asserts the capture actually sees the request prefix.
Extend `test/e2e/bridge.test.ts` with the scripted provider: assert published `parts.system` and
`parts.tools` are non-zero and that the captured message carried `toolsAdded`.

**R17 — Minor: naming.** `counts.images` counts blocks while `imageTokens` counts tokens. Name them
`imageBlocks` and `imageTokens`.

### 12.3 Revised implementation order

1. **Plan corrections** — this section and the inline fixes (done).
2. **Spike (Phase 0)** — risk-first: confirm `context_with_system` shape/order/cost,
   `getSettings().compaction`, `getContextUsage` cost and its `undefined` vs `{tokens:null}` cases, and
   the separate `ModelRuntime` window lookup without network I/O. Everything else is already confirmed.
3. **Bridge + protocol (Phase 1)** — types, capture + fallback, parts, history from entries,
   `compactAt`, `initialState`, `model_select` refresh; unit and protocol tests. No UI yet.
4. **Detail block (Phase 2)** — the smallest visible surface, and it validates the data before the
   aggregate view is built.
5. **Context view + cumulative (Phase 3)** — depends only on live data, so it ships before the
   indexer.
6. **Indexer + ended fill + windows (Phase 4)** — cache v2, latest/peak/model, window lookup;
   independent of phases 3–5.
7. **Gateway + Android (Phase 5, optional)** — wire change, fixture, Kotlin decode tests.
8. **Docs/close-out (Phase 6)** — README, claim limits, repository gates.

Rationale: data before UI, aggregate before historical, and the only genuinely uncertain API surface
is validated before anything is built. Effort estimates in §5 are unchanged.
