# pi-dash — Plan 3: ask a session about itself

Status: implemented 2026-10-04 (all phases). Results are in §8. Source: a read of GatPi-Harness's
`/ask` sidecar, the bridge, the pi 0.84.1 runtime that the bridge runs in, and a measurement on
six real session files (§2). `PLAN.md` stays the design record; decisions are recorded there
(marked *Updated (plan 3)*). Decisions changed during implementation are marked *Updated* here.

## 1. Goal

From the dashboard, ask a running session a question about its own work ("what are you doing
right now?", "why did you change X?", "is the test run stuck?", "what is left?") and get an answer
that is as well-informed as the session's own model. The question and answer must not change the
session: nothing is added to its transcript or its context, and the run is not interrupted.

## 2. Why the existing `/ask` sidecar falls short

GatPi-Harness `/ask` (`.pi/extensions/reasoning-runtime/index.ts`, `snapshotSessionForAsk` and
`startAskRun`) flattens a text snapshot into one user message and sends it to the session's model
with a short system prompt of its own. How the snapshot is built explains the gaps:

| # | Limitation | Cause in `snapshotSessionForAsk` / `startAskRun` |
|---|---|---|
| L1 | Does not see what tools returned: file contents, command output, test failures, diffs | `toolResult` messages are skipped |
| L2 | Does not see what the model did: which files it edited, which commands it ran | tool calls have no `text`, so `textOf` drops them; an assistant turn that only calls tools disappears |
| L3 | Forgets everything before a compaction | `getBranch()` is the raw tree path; the `compaction` entry (the summary) is not a `message`, so it is skipped |
| L4 | Forgets older work in long sessions | only the last 80 branch entries (of every type), each clipped to 1600 characters with whitespace collapsed, and 24,000 characters in total |
| L5 | Does not know what is happening now | the in-flight assistant message (text, thinking, tool call being formed) is persisted only at `message_end`; running tools have no result yet |
| L6 | Does not know its instructions or tools | the session's system prompt (AGENTS.md, skills, project context) and tool list are replaced by a 2-line sidecar prompt |
| L7 | Extension-injected context is lost | `custom_message` and `branch_summary` entries are skipped |
| L8 | Answers from a summary, not as the session | the transcript is a single text blob ("user: … assistant: …"), without the session's thinking level |

Measured on the six most recent session files (the `/ask` snapshot vs. the serialized messages pi
would send to the model; JSON size overstates the context somewhat, but not by these ratios):

| Session | Branch entries | Compactions | Model context (chars) | `/ask` snapshot (chars) | Share |
|---|---|---|---|---|---|
| ProjectB | 9,929 | 16 | 1,548,396 | 974 | 0.1% |
| ProjectC | 3,475 | 13 | 578,229 | 1,805 | 0.3% |
| GatPi-Fleet | 98 | 0 | 381,404 | 2,327 | 0.6% |
| GatPi-Fleet | 344 | 1 | 223,346 | 5,764 | 2.6% |
| ProjectA | 463 | 1 | 193,428 | 5,307 | 2.7% |
| GatPi-Fleet | 49 | 0 | 97,107 | 3,929 | 4.0% |

So `/ask` answers from 0.1–4% of what the session's model actually sees.

## 3. Decisions

- **D1 The session answers, in its own process.** The ask runs in the pi-dash bridge, inside the
  pi process: it has the session's entries, model, credentials and live events. The dashboard
  sends the question over the existing socket. Asking through pi's agent loop
  (`sendUserMessage`) is ruled out: it would add the question to the transcript and wait behind
  the run.
- **D2 Same context as the model.** In pi 0.84.1 every request is `{ systemPrompt,
  convertToLlm(transformContext(messages)), tools }` with `reasoning` = thinking level and
  `sessionId` (`agent-loop.ts`, `agent.ts`). The ask rebuilds the same thing:
  - system prompt: `ctx.getSystemPrompt()`;
  - tools: the active tools (`pi.getActiveTools()`, in that order) with their definitions from
    `pi.getAllTools()` (name, description, parameters);
  - messages: `convertToLlm(buildSessionContext(entries, leafId).messages)`. This is
    compaction-aware (summary plus kept messages) and includes tool calls, tool results, thinking
    and custom messages (fixes L1–L4, L6, L7).

  The only difference from a real request is extension `context` transforms. Today none rewrite
  anything; GatPi-Harness's trace-observability only observes. *Updated:* pi-multi-account has two
  conditional `context` handlers: with automatic failover on, it folds aborted or failed turns
  into user records; its mid-run guard elides the oldest tool results once a run's context grows
  past a soft limit. When either applies, the ask sees the untransformed history (§7).
- **D3 Live state.** Completed turns are already persisted (pi appends each message at
  `message_end`). For what is in flight, the bridge tracks the partial assistant message
  (`message_update`) and each running tool's output tail (`tool_execution_update`). At ask time:
  - each running tool call gets a tool result written by the bridge: `Still running (started 2m10s
    ago). Output so far: …` (last 2,000 characters). Without it, pi-ai would insert
    `No result provided` for the unanswered call, which reads like a failure;
  - the question message starts with a short status block: idle or working, how long, and the
    partial message being written: its text, the tool calls it is forming, and the last 2,000
    characters of its in-flight thinking (fixes L5).
- **D4 The question.** One trailing user message: `[Side question from the user, asked from
  pi-dash. Answer it from what you know of this session. Do not call tools and do not continue the
  task. This exchange is not added to the session.]`, the status block, then the question.
- **D5 Cache-friendly request.** Use the session's model, thinking level and `sessionId`, and
  declare the same tools without changing `toolChoice`. The request then shares the provider's
  cached prefix with the session's own last request. On Anthropic, cache reads cost about a tenth
  of uncached input, and a change to tools, `tool_choice` or thinking settings invalidates the
  cached messages. This matters because asks resend the whole context, often 100k+ tokens. No tool
  ever runs. If the model calls one anyway, the answer is its text; if there is no text, the ask
  fails with "tried to call <tool> instead of answering". Phase A checks this assumption first.
  *Updated:* Phase A confirmed it (§8). The live check then found the case it misses: once the
  session's own cache has expired, an ask writes the cache up to its last block, the question, so
  the next ask reuses only the system prompt and tools (21%). The bridge moves Anthropic's message
  cache mark from the question to the end of the session's context (`cacheBeforeQuestion`, an
  `onPayload` hook; same number of marks), so consecutive asks, and the session's next turn, reuse
  it (100%).
- **D6 Model call API.** Use `streamSimple` from `@earendil-works/pi-ai/compat` with
  `ctx.modelRegistry.getApiKeyAndHeaders(model)`, as pi 0.84.1's own compaction does. pi's
  extension loader maps that import to its bundled copy. `modelRegistry.streamSimple` exists only
  in pi 1.x; the runtime here is pi 0.84.1 (`/home/user/pi`), while the repo type-checks against
  1.0.0. Both versions have every API this plan uses, and the e2e run against the real `pi` is the
  gate. `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` move to `peerDependencies`
  (`"*"`), as pi's packages.md requires for host-provided packages imported at runtime.
  *Updated:* the bridge calls `ctx.modelRegistry.getProvider(model.provider).streamSimple(...)`,
  which is what pi's registry does internally. The global pi-ai `streamSimple` would bypass
  providers that extensions registered: pi-multi-account registers the Claude OAuth request
  shaping on the `anthropic` provider. Only `@earendil-works/pi-coding-agent` (the one runtime
  import, `buildSessionContext`) is a peer dependency; pi-ai is imported for types only. pi 1.x
  records the system prompt and tools in the transcript as system messages; `buildAskContext`
  sends such a transcript as is and passes the prompt and tools beside it only when it does not
  declare them. The e2e suite runs green on both pi 0.84.1 and 1.0.0.
- **D7 No transcript mutation.** No session entries are written. Questions and answers live in the bridge's memory for the life of the pi process, so
  they survive a dashboard restart but not `/reload`, `/new` or a pi restart. An answering ask is
  aborted on `session_shutdown`.
- **D8 Protocol v3.** Following Plan 2 D1: `PROTOCOL_VERSION = 3`, no compatibility layer.
  - Command `{ kind: "ask"; question: string }`, acknowledged once the ask has started. It is
    rejected when the question is empty, there is no model or credentials, or an ask is already
    answering. One ask at a time per session.
  - State field `asks: AskRun[]`: the last 10, oldest first, each `{ id, question, askedAt,
    status: "answering" | "answered" | "failed", answer, error?, usage?: { input, cacheRead,
    output, cost } }`. The answer is capped at `SAID_LIMIT`. While an ask answers, its text grows
    through ordinary patches, so the existing 250 ms coalescing streams it.
- **D9 Standalone questions.** Each ask sees the whole live session but not earlier side answers.
  The main gap was missing session context, not missing follow-ups (open question 1).
- **D10 Cost is visible, not merged.** Each answer shows its tokens, cache-read share and cost.
  Asks are not added to session usage totals. The README already says LLM calls that extensions
  make outside the transcript are not counted.
- **D11 Dashboard.** `A` (ask) in the overview and detail views opens a full-screen ask view for
  the selected session:
  - the thread of its asks, newest at the bottom: each question, its status, the answer in
    Markdown (the same renderer as the reader), and its usage line;
  - pi's editor underneath for the next question: `⏎` asks, `Esc` closes;
  - scrolling with `↑↓`, `PgUp`, `PgDn`, `Home`, `End` and the wheel.

  *Updated:* the key is `i` (inquire), which is free and unique, rather than `A` next to `a`.
  `Home`/`End` and `↑↓` belong to the editor while it holds text; `↑↓` scroll only when it is
  empty. The view follows the newest answer until you scroll up, and a growing answer does not move
  a scrolled-up thread.

  While an ask answers, `⏎` is refused with "still answering". Closing the view does not cancel
  the ask. When an answer lands while the view is closed, a notification names the session.

## 4. Phases

Each phase ends green (`npm run check`, `npm test`) with a working dashboard.

### Phase A — Spike: does the rebuilt context hit the cache?

A throwaway local extension (`pi -e`, not committed) with an `/ask-probe <question>` command that
builds the request per D2–D5 and prints the answer plus `usage`.

1. Run it in a real Anthropic session that has tool results and a compaction, idle and while it
   works. Record `cacheRead / (input + cacheRead)`. Check that the answer quotes something that
   only appears in a tool result, and something from before the compaction.
2. The same in a session on the OpenAI/codex provider.
3. Running-tool case: confirm the request is accepted with the bridge-written result (D3), and
   with a user message that directly follows a user message (a prompt the model has not answered
   yet).

Gate: cache reads ≥ 80% of input on Anthropic. If the gate fails, find which part breaks the
prefix (tool order, descriptions, thinking options) by diffing the two `before_provider_request`
payloads. Fix that, or revise D5 with the measured cost before Phase B.

### Phase B — Bridge: ask engine and protocol v3

1. `src/bridge/ask.ts`: a pure `buildAskContext({ systemPrompt, tools, messages, live, question,
   now })` → pi-ai `Context` (D2–D4), plus the answer extraction rule from D5.
2. Bridge live tracking: partial assistant message (`message_update`, cleared at `message_end`),
   output tail per running tool (`tool_execution_update`).
3. Ask runner: one at a time, `streamSimple` per D5/D6, stream text into `asks`, record usage,
   map errors (provider error, prompt too long, tool-call-only) to `failed` with a message, abort
   on shutdown.
4. Protocol: `PROTOCOL_VERSION = 3`, `ask` command, `AskRun`, `asks` in `SessionState` (empty at
   startup).
5. `package.json`: peer dependencies per D6.

Tests:
- Unit tests for `buildAskContext` with a `SessionManager.inMemory` fixture: a compaction summary,
  tool calls and results, a custom message, a running tool, and a partial message. Assert the
  summary, a tool-result marker, the system prompt and tools, the bridge-written result and the
  status block, with the question last.
- e2e: the scripted provider answers a side question with a digest of the request it received
  (whether a system prompt and tools were present, roles, markers found). Cases: ask while idle
  after a tool run sees the tool's output; ask during `sleep N` names the running `sleep` and its
  elapsed time; the session file gains no entries and `lastSaid` is unchanged; a second ask while
  one is answering is rejected; a provider failure gives a `failed` run.

### Phase C — Dashboard: the ask view

1. `AskView` overlay (`src/dashboard/ui/overlays.ts`): thread plus editor, reusing `TextPane`,
   `Editor` and `frame`.
2. `A` in the overview and detail views, the footer and help. A notification when an answer
   arrives while the view is closed.
3. The store needs no change: `asks` arrives as an ordinary state field.

Tests: app tests (`A` sends the `ask` command; `⏎` is refused while answering), render tests
(answering, answered with usage, failed; 80×24 and 150×45).

### Phase D — Docs and verification

1. README: `A` key, what the ask sees and does not change, cost note, the v3 rollout (restart
   pi-dash, then `/reload` each session).
2. PLAN.md: *Updated* notes for protocol v3 and the ask.
3. Verification: `npm run check`, `npm test`, `npm run test:e2e`. Live, against real sessions:
   - an idle session about something only a tool result contains;
   - a working session: "what are you doing right now?";
   - a session with compactions, about work from before the last one.

   Record the answers' cache-read share and cost. Then one diff review.
4. Results section below.

## 5. Out of scope

- Follow-up memory between side questions (open question 1).
- Letting the side question run tools, or turning an answer into session state.
- Asking from inside pi. GatPi-Harness `/ask` lives in another repo; it could adopt
  `buildAskContext`'s approach separately.
- Asking several sessions at once.

## 6. Open questions (resolved)

1. **Follow-ups.** No: each question stands alone (D9).
2. **In-flight thinking.** Kept, as the most current view of the work. It goes only to the
   session's own model and provider, which produced it; the dashboard never displays it.
3. **Model.** Always the session's model and thinking level.
4. **Key.** `i` (D11): unique, rather than `A` beside `a`.

## 7. Risks

- **Version skew.** Types come from pi 1.0.0, the runtime is pi 0.84.1. Mitigation: use only APIs
  present in both (checked: `getSystemPrompt`, `getActiveTools`, `getAllTools`,
  `buildSessionContext`, `convertToLlm`, `modelRegistry.getProvider`, `getApiKeyAndHeaders`).
  *Updated:* the e2e suite runs against both (§8).
- **Cache misses.** If tool definitions or their order differ from the agent's, every ask pays full
  input price. Phase A measures this before anything is built on it.
- **Full contexts.** pi keeps `reserveTokens` (16,384) free, so a question and an answer fit unless
  the context is already over the window. In that case the provider error shows as a failed ask.
- **Shared limits.** Asks use the session's account. A 429 fails only the ask: a direct
  `streamSimple` call does not emit `after_provider_response`, so the row's rate-limit state is
  untouched.
- **Context transforms.** Asks see the history without extension `context` transforms. *Updated:*
  pi-multi-account's two conditional handlers (D2) do rewrite it. Then the ask sees more than the
  model did (elided tool results, interrupted turns as pi-ai drops them), and its prefix no longer
  matches the session's, so it misses the cache.

## 8. Results

**Phase A (spike).** A throwaway extension built the request with `buildAskContext` in a fork of a
real compacted Claude session (77k tokens), then on the same session switched to openai-codex:

| Case | Cache read | Cost | Answer |
|---|---|---|---|
| Claude, idle | 99.8% | $0.023 | diff stat (only in a tool result) and a pid (only in the compaction summary): both right |
| Claude, during `sleep 45` | 99.7% | $0.019 | named the running command and its elapsed time |
| Claude, before the first reply (partial thinking) | 99.7% | $0.020 | knew the unanswered prompt and that the haiku was not written yet |
| Codex (gpt-5.5), idle | 98.3% | — | both facts right |

The request carried the same system prompt, tools, thinking settings and message prefix as the
session's own request (payload hashes). Gate passed; D5 kept.

**Phase B (bridge).** `src/bridge/ask.ts` (pure request building, answer extraction, cache mark)
and the bridge's ask runner, live tracking and protocol v3. Unit tests (`test/ask.test.ts`, 10):
- the whole model context, unchanged, before the question; tool calls and thinking kept;
- compaction: summary first, kept messages, extension messages; summarized messages absent;
- tool outputs verbatim; a 150-call session sent whole;
- orphaned calls: a running tool's call gets a "still running" result after the results already
  in; an orphaned call that is not running is left to pi-ai, as in the session's own requests;
- the reply in progress (thinking tail, text, prepared tool calls);
- a pi 1.x transcript with system messages is sent as is;
- answer extraction; the Anthropic cache mark.

Dropping tool results from the context fails 4 of these tests (mutation check). e2e
(`test/e2e/bridge.test.ts`, 3 new tests against a real interactive pi):
- an idle ask sees the system prompt, tools, compaction summary and a tool's output, and writes
  nothing to the session file or its usage;
- an ask during `sleep 4` sees the call as still running, and a second ask is rejected;
- an empty question is rejected, and a provider failure fails only the ask.

The suite (17 tests) passes on pi 1.0.0 and on the installed pi 0.84.1.

**Phase C (dashboard).** `AskView` on `i`, plus notifications; 2 app tests and 1 render test
(80×24 and 150×45, follow and scroll position).

**Phase D (live, disposable fork of a real session, real dashboard in a private tmux socket):**

| Question | Cache read | Cost |
|---|---|---|
| diff stat, pid, last reply (session cache expired) | 0% | $0.38 |
| main goal of the session (before the cache-mark fix) | 21% | $0.30 |
| which commit it created (after the fix) | 100% | $0.02 |
| "what are you doing right now?" during `sleep 40` | 99% | $0.02 |
| "did the command finish?" after it settled | 100% | $0.02 |

All answers were correct. The session file never contained a side question. The closed-view
notification and the 80×24 layout were checked on screen.

**Remaining gaps.**
- The first ask after the session's prompt cache expired (5 minutes idle on Claude) pays full
  input price: $0.38 for 75k tokens. Later asks, and the session's next turn, reuse the cache
  that ask writes.
- Asks are not in session usage totals or quota shares (D10); they appear only in the ask view.
- Extension `context` transforms are not applied (§7). pi-multi-account's failover folding and
  mid-run guard rewrite context when they apply; such asks see the unrewritten history and miss
  the cache.
- Custom `thinkingBudgets` from pi settings are not visible to extensions, so asks use the default
  budgets. A session with custom budgets sends different thinking settings and misses the cache.
- On pi 1.x, cache sharing is untested with a real provider: the e2e suite there uses the scripted
  provider, and the live checks ran on pi 0.84.1.
- Answers live in the bridge's memory: `/reload`, `/new` or a pi restart clears them.
- Live sessions need `/reload` (after restarting pi-dash) before they accept asks.
