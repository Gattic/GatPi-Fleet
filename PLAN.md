# pi-dash — Pi Session Dashboard & Manager TUI: Plan

Status: implemented (all phases), 2026-10-03. Usage and install are in `README.md`. This file
is the design record. Decisions changed by your answers (§10) or by the Phase 0 spikes are
marked *Updated*. Results are in §12.

## 1. Goal

One terminal tab that shows and drives every running pi session, so tab-hopping
between ~6 `screen` sessions becomes the exception instead of the workflow.

At a glance (no reading required) the dashboard must answer:

1. Which sessions are **working**, which are **waiting on me**, which **broke**?
2. **Where is each session in its plan/roadmap?**
3. What is each session costing in **CPU / memory / GPU** — the pi process itself
   (*direct*) and everything it launched (*indirect*: tools, builds, jobs, subagents)?
4. What is each session costing in **API usage** (tokens, $, subscription quota windows),
   directly and through subagents?

And it must let me act without visiting the session: **prompt / steer / follow-up,
abort, close, start new, resume, peek, attach**.

### Non-goals (v1)

- Replacing pi's own TUI for deep work (attach is one key away instead).
- Remote/multi-machine monitoring, web UI.
- Model/thinking switching, compaction, tree navigation from the dashboard.
- Editing roadmaps from the dashboard (read-only plan view).

## 2. Current workflow and what was verified on this machine

Workflow today: per terminal tab → `screen -c ~/.screenrc-<proj> -S <proj>` → `pi` /
resume → prompt loop → quit → new pi. Typically 3 working, up to 6.

Verified facts this plan builds on (checked 2026-10-03, pi 0.84.1, Node 22.22.2):

| Fact | Evidence | Used for |
|---|---|---|
| 5 screens live (`blog`, `cli`, `proja`, `webapp`, `dashtui`), one `pi` each, each run from a shell inside screen | `screen -ls`, `ps` | discovery/adoption |
| Each pi process carries `STY=<pid>.<name>` and `WINDOW` in `/proc/<pid>/environ`; `cwd` via `/proc/<pid>/cwd` | `/proc` reads | map pi ↔ screen ↔ project |
| pi processes themselves burn real CPU (instant samples: 143 %, 102 %, 51 % with zero descendants) | 2 s `/proc/<pid>/stat` delta | *direct* CPU is meaningful |
| `build_project` runs work via `systemd-run --user --wait` → transient unit `run-p<clientPid>-i<n>.service` **outside** pi's process tree; its cgroup exposes `cpu.stat`, `memory.current` (3.4 GB observed) | `systemctl --user`, `/sys/fs/cgroup/.../app.slice/run-p360222-*.service` | *indirect* attribution a plain process tree would miss |
| `bg_run` jobs are detached supervisors recorded in `<cwd>/.pi/jobs/<job>.json` (pid, ownership.startTime); `run_deck` runs in `<cwd>/.pi/run-deck/` | `GatPi-Harness/src/bg-jobs.js`, `run-deck.js` | *indirect* attribution of detached jobs |
| Subagents are detached child `pi --mode rpc` processes with `--session-dir <cwd>/.pi/subagents/rpc-sessions/<id>` (or `--no-session`) | `GatPi-Harness/src/subagents.js` | *indirect* CPU + API usage |
| Bash-tool children inherit `PI_SESSION_ID` (9 procs carried it) | `/proc/*/environ` scan | attribute orphaned/daemonized tool processes |
| Session JSONL assistant messages carry `usage {input, output, cacheRead, cacheWrite, totalTokens, cost.total}`; `toolResult.usage` = nested LLM work by a tool | `docs/session-format.md`, sample file | API usage |
| Session files are large (up to 525 MB; 6.7 GB total) | `du`, `ls -S` | never re-parse whole files in the UI loop |
| Account quota windows already tracked: `~/.pi/agent/provider-failover-state.json` → `usageByProvider.<p>.primary/secondary {usedPercent, resetAt, windowSeconds}` (anthropic 5 h 24 %, weekly 26 %; codex weekly) + `exhaustedUntilByProvider` | file read | quota gauges |
| Roadmap is per-project `<cwd>/.pi/roadmap/active.json`; all mutations funnel through `commit()` in `GatPi-Harness/.pi/extensions/roadmap/index.ts`; `roadmap-state.js` exports `getProgress`, `getActivePath`, `summaryLine` | source | plan progress |
| Extension API gives everything needed for live state + control: `agent_start/agent_end/agent_settled`, `turn_*`, `message_end` (usage), `tool_execution_start/end`, `session_start/shutdown`, `model_select`, `after_provider_response` (429/headers), `ctx.getContextUsage()`, `ctx.abort()`, `ctx.shutdown()`, `pi.sendUserMessage(text, {deliverAs: "steer"\|"followUp"})`, `pi.events` bus | `docs/extensions.md` | bridge |
| `pi.sendUserMessage` bypasses slash-command handling (`expandPromptTemplates: false`) | `core/agent-session.ts:1531` | no in-place `/new` from the dashboard → launch new processes instead |
| `@earendil-works/pi-tui` has alt-screen viewport, `VStack`/`HStack`/`ScrollView` layout, `Editor`, `SelectList`, overlays, mouse, and `VirtualTerminal` (xterm-headless) for tests; no chart widgets | `packages/tui/README.md` | TUI stack |
| Node 22.22 runs `.ts` directly (type stripping) | `node --input-type=module-typescript` | no build step |
| GPU: one NVIDIA GPU, `nvidia-smi` present; `notify-send` present; tmux 3.7c and screen 5.0.1 installed | shell | GPU panel, alerts |

## 3. Architecture

```
 ┌──────────── screen "proja" ───────────┐      ┌──────────── screen "blog" ────────────┐
 │ pi (TUI, unchanged for the user)      │ ...  │ pi (TUI)                              │
 │  └─ pi-dash bridge extension          │      │  └─ pi-dash bridge extension          │
 │       unix socket $XDG_RUNTIME_DIR/   │      │       .../pi-dash/<pid>.sock          │
 │       pi-dash/<pid>.sock              │      │                                       │
 └──────────────┬────────────────────────┘      └──────────────┬────────────────────────┘
                │ JSONL: snapshot + patches ↑  commands ↓       │
 ┌──────────────┴───────────────────────────────────────────────┴──────────────────────┐
 │ pi-dash (separate process, own terminal tab, stateless)                             │
 │  collectors:  bridge-client · proc-sampler (+cgroups, jobs) · gpu · host · quota    │
 │               · usage-history (incremental session-file indexer, Phase 4)           │
 │  store:       sessions + ring buffers (2 s × 10 min, 1 min × 24 h)                  │
 │  actions:     prompt/steer/follow-up/abort/close (bridge) · new/resume/attach/peek  │
 │               (screen)                                                              │
 │  ui (pi-tui): Overview · Detail · Usage · Composer · Launcher/Resume · Peek · Help  │
 └─────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Key decisions

**D1 — Live state comes from an in-process bridge extension, not scraping.**
A small pi extension loaded in every interactive session pushes authoritative state
(phase, current tool, usage, context %, plan) and executes commands.
Rejected alternatives:
- *Scrape session JSONL + screen hardcopy only*: cannot tell "working" from "idle"
  reliably, files are up to 500 MB, and there is no control channel.
- *Dashboard owns sessions via `pi --mode rpc`*: loses pi's native TUI that I still
  want to attach to.
- *Experimental `@earendil-works/pi-server` / `pi-client`*: not wired to the
  interactive CLI and explicitly unstable.

**D2 — The dashboard is a pure client and stateless.** Each bridge is a tiny server on
`$XDG_RUNTIME_DIR/pi-dash/<pid>.sock` (dir 0700, socket 0600). The dashboard discovers
sockets, connects, receives a full snapshot, then patches. Restarting or crashing the
dashboard never affects sessions; all durable truth stays in pi/session files.

**D3 — Keep GNU screen as the terminal host.** It is the current habit, every existing
session is already discoverable via `STY`, and it has every primitive needed:
`screen -dmS` (launch detached), `screen -rx` (multi-display attach), `screen -X hardcopy` (peek).
tmux was considered (richer `capture-pane -e` with colors) but would force a workflow
change for little v1 gain. One host, no abstraction layer over multiplexers.

**D4 — TUI stack: TypeScript on `@earendil-works/pi-tui`, run directly by Node 22.**
Same runtime and editor component as pi (the prompt composer behaves exactly like pi's
editor), alt-screen fixed layouts, `VirtualTerminal` for render tests, no extra
framework. Missing chart primitives are written once as small components
(sparkline, gauge, split bar, stacked area, activity lane — Unicode blocks/braille;
Ptyxis/VTE has no Kitty graphics).
Rejected: Ink (another framework), Textual/ratatui/Bubble Tea (second language for a
tool that must share protocol types with a TS pi extension).

**D5 — Plan progress via the `pi.events` bus, owned by the roadmap extension.**
Small change in `GatPi-Harness`: the roadmap extension emits `roadmap:changed`
`{title, complete, total, lifecycle, activePath[]}` from its single `commit()` and on
`session_start`, and answers `roadmap:request`. The bridge forwards it. The roadmap file
format stays owned by `roadmap-state.js` (single source of truth; no second parser,
no file watching). Sessions without a roadmap show the last user prompt as their "goal".

**D6 — New/resume = new pi process in a new detached screen.** Because extensions cannot
run `/new` from a socket callback, "recycle" is: graceful `ctx.shutdown()` via bridge →
`screen -dmS pi-<label> -c ~/.screenrc-empty sh -c 'cd <cwd> && exec pi [--session <id>] [--name <n>]'`.
When pi exits, its managed screen ends — no leftover shells, no keystroke injection.
Existing user-created screens are adopted for monitoring/control as-is.

**D7 — Bridge is active only in interactive TUI mode** (`ctx.mode === "tui"`), so
`pi -p` one-shots and RPC subagents never open sockets.

### 3.2 Bridge extension (`src/bridge/`)

Registered once in `~/.pi/agent/settings.json` → `"extensions": [".../GatPi-Fleet/src/bridge/index.ts"]`.

Lifecycle: open socket on `session_start`, close + unlink on `session_shutdown`
(pi re-instantiates extensions on `/new`, `/resume`, `/fork`; the pid-keyed path is
simply recreated and the dashboard reconnects). Server is `unref()`'d.

Event → state mapping:

| pi event | bridge state change |
|---|---|
| `session_start` | identity: pid, `STY`, `WINDOW`, cwd, sessionId, sessionFile, name, model, thinking; usage totals + last-120-min per-minute buckets computed once from `ctx.sessionManager.getEntries()` (already in memory); request plan |
| `session_info_changed`, `model_select`, `thinking_level_select` | name / model / thinking |
| `input` | `lastPrompt` (first 200 chars) |
| `agent_start` | `phase=working`, `since` |
| `message_update` | `activity=thinking|streaming` (flag only — never per-token emits) |
| `tool_execution_start/end` | `activity=tool:<name>` + short arg summary (e.g. first 60 chars of bash command); tool timeline entry; capture `bg_run`/`run_deck` job ids + pids from result details |
| `message_end` (assistant) | direct usage delta `{ts, model, tokens…, cost}`; `stopReason=error|aborted` → `lastError`; `lastSaid` = assistant text (*updated:* the whole text, bounded to 32 000 chars, so the detail view can show and scroll it) |
| `message_end` (toolResult with `usage`) | indirect usage delta |
| `session_compact` | compaction usage; activity `compacting` |
| `agent_end` (before settled) | `activity=continuing` (retry / compaction / queued follow-up) |
| `agent_settled` | `phase=idle` (**needs you**), `since`, `ctx.getContextUsage()` |
| `turn_end` | context usage refresh |
| `after_provider_response` status 429 | `rateLimited {retryAfter}` |
| `pi.events "roadmap:changed"` | `plan` |
| `pi.events "prompt-suggestion:changed"` (*added*) | `suggestion`: GatPi-Harness prompt-suggestions' next prompt, null while working |

Commands (each with request id and ack/error):

| command | implementation |
|---|---|
| `prompt {text, mode}` | `pi.sendUserMessage(text)` when idle; `{deliverAs: "steer"|"followUp"}` when working (dashboard picks a default, user can switch) |
| `abort` | `ctx.abort()` |
| `shutdown` | `ctx.shutdown()` (graceful; waits for idle) |
| `rename {name}` | `pi.setSessionName(name)` |

Rules: patches coalesced to ≤ 4 Hz; no file I/O on hot paths; payload strings truncated;
protocol `hello {version}` handshake; overhead target < 0.5 % of one core.

### 3.3 Protocol (`src/protocol/`)

LF-delimited JSON over the unix socket (same framing discipline as pi RPC: split on
`\n` only). Bridge → client: `hello {version}`, `snapshot`, `patch` (top-level field
replacement, `null` clears), `ack {id, ok, error?}`, `bye {reason}`. Client → bridge:
`command {id, command}`. *Updated:* usage and tool timeline travel as ordinary patch fields
(`usage`, `usageMinutes`, `tools`) instead of separate message types, because one mechanism
was enough. Shared TypeScript types are used by both sides, with one version constant.

### 3.4 Session status model

| State | Glyph/colour | Source |
|---|---|---|
| working · thinking / streaming / tool `<name>` / continuing | animated `⠋⠙⠹…` green, activity icon `✎` `⚙` `⟳` | bridge |
| **needs you** (idle after settle) | `◆` amber, waiting timer | bridge |
| error (last stop `error`, 429, provider exhausted) | `✖` red | bridge + quota file |
| stalled? (working, no event > 3 min, pi + indirect CPU ≈ 0) — usually a blocking dialog | `◆?` amber-red, hint "v to peek" | dashboard-derived |
| exited (bridge `bye quit` or pid gone) | `◌` grey, stays until dismissed; `r` resumes | dashboard |
| unbridged (pi pid found in `/proc` without socket, e.g. started before install) | `?` dim; resources only | proc-sampler |

Transitions into **needs you**, **error** or **stalled?** raise an alert: the row is
highlighted for 15 s or until it is selected. *Updated:* no terminal bell and no
`notify-send`, since you asked for no desktop notifications.

Sessions keep stable slot numbers `1–9` (assigned by first sight, reused after dismissal)
so muscle memory works; urgency is shown by colour, not by re-sorting.

### 3.5 Resource attribution (direct vs indirect)

Sampler tick every 2 s (GPU every 5 s). Processes are keyed by `(pid, starttime)` to
survive pid reuse. Per tick:

1. Read `/proc/*/stat` once → ppid map, utime+stime, rss; CPU% from deltas.
2. **Direct** = the pi process itself.
3. **Indirect** = union of:
   - descendants of the pi pid (bash tools, LSP servers, subagent `pi --mode rpc`);
   - systemd transient units `run-p<clientPid>-*.service|scope` whose client pid is a
     descendant → cgroup `cpu.stat usage_usec` delta + `memory.current`;
   - `bg_run` supervisors and subagents. *Updated:* both are spawned by the pi process
     (`detached` = new session, but pi stays the parent while it runs), so the descendant
     walk already covers them. No job-id tracking was needed. `run_deck` only registers
     runs; it does not spawn them;
   - CPU time of children reaped between two ticks, via the parents' `cutime/cstime`.
     Short tool commands are not lost, and processes that exit are not counted twice;
   - orphans whose `/proc/<pid>/environ` contains this session's `PI_SESSION_ID`
     (environ read once per new pid, cached).
4. GPU: `nvidia-smi --query-gpu` (device utilisation and memory) and
   `--query-compute-apps` (per-pid VRAM), mapped through the same pid sets. The panel is
   hidden when `nvidia-smi` is absent. *Updated:* no per-process SM%, because `pmon`
   reports `-` for it on this host's GPU.
5. Host header: `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`.

### 3.6 API usage model

- **Direct, live**: bridge usage deltas (assistant messages + compaction/branch summaries).
- **Indirect**: `toolResult.usage` (nested LLM work, live from the bridge) plus subagent
  sessions. *Updated:* subagent files under `<cwd>/.pi/subagents/rpc-sessions/<id>/` are
  read by the same incremental indexer (every 15 s), not tailed separately. The parent
  session comes from GatPi-Harness's `<cwd>/.pi/subagents/records/<id>.json`
  (`parentSessionId`), so subagent cost counts toward the session that spawned it.
- **Account quota**: watch `~/.pi/agent/provider-failover-state.json`; show each window's
  `usedPercent`, reset countdown, freshness, exhausted-until. Per-session share of the
  current window is an *estimate* (each session's tokens in the window, cost-weighted) and
  labelled as such.
- **History (Phase 4)**: incremental indexer over `~/.pi/agent/sessions/**` and
  `<cwd>/.pi/subagents/rpc-sessions/**` for files modified inside the selected range
  (today / 7 d / 30 d). Streams only bytes after the last offset in a worker thread;
  cache `~/.cache/pi-dash/usage-index.json` = per-file `{size, mtime, offset, hourly buckets}`.
  The cache is derived and disposable; entries for deleted files or files older than
  30 days are pruned at startup.
- Dollar figures are pi's computed **API-equivalent cost**; with subscription logins the
  real constraint is the quota windows, so both are shown.
- Known gap: LLM calls made by extensions outside the session (e.g. advisory/memory
  helpers) are not in session usage; shown as "not tracked" in help, not guessed.

## 4. UX design

### 4.1 Principles

- One line per session in the overview; details only for the selected session.
- Colour + glyph carry state; numbers are compact (`3.9c`, `9.4G`, `$7.9`, `12m`).
- Every metric has a shape: sparkline (trend), gauge (fraction of a limit), split bar
  (direct ▓ vs indirect ▒), activity lane (time spent working / waiting on me / idle).
- Text is truncated to width, never wrapped. Legends live behind `?`. *Updated:* the one
  exception is the latest reply (SAID) in the detail view, which wraps and scrolls.
- Gauge colours: green < 60 %, amber < 85 %, red ≥ 85 %.

### 4.2 Overview (default, ≥ 120 cols)

```
╭─ pi-dash ──────────────────────────────────────────── ⠹ 3 working  ◆ 1 needs you  ✖ 1 error ── 12:47 ─╮
│ QUOTA anthropic 5h ▕██████░░░░░░░░░░▏24% ↻2h13m  wk ▕████░░░░░░░░▏26%  codex wk ▕░░░░░░░░▏0%          │
│ HOST  cpu ▁▂▅▇█▇▅▃▄▆ 63%  mem ▕████████░░░░▏21/31G  gpu ▁▁▁▁▁ 0% 0.0/4G   today $14.20 ▁▂▃▅▇           │
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   SESSION   STATE                 PLAN                     CPU           MEM (pi▓ ind▒)  API/min   $  │
│ 1 blog      ⠹ ⚙ bash 4m12s        ▰▰▰▰▱▱ 4/6 Wire API      ▂▅▇█▇ 1.8c   ▓▓▒▒▒▒▒  5.7G   ▃▅▂▁▁   4.1 │
│ 2 cli       ⠼ ✎ thinking 38s      ▰▰▱▱▱▱ 2/6 Add tests     ▁▁▂▂▁ 0.2c   ▓░░░░░░  0.4G   ▁▂▇▅▃   1.0 │
│▶3 proja     ⠧ ⚙ build 12m         ▰▰▰▰▰▱ 5/6 Verify        ▇▇██▇ 3.9c   ▓▓▒▒▒▒▒  9.4G   ▁▁▁▁▁   7.9 │
│ 4 webapp    ◆ needs you 8m        ▰▰▰▰▰▰ done              ▁▁▁▁▁ 0.0c   ▓░░░░░░  0.7G   ▁▁▁▁▁   2.4 │
│ 5 dashtui   ✖ 429 rate limited    "plan the dashboard"     ▁▁▁▁▁ 0.1c   ▓░░░░░░  0.2G   ▁▁▁▁▁   0.6 │
├─ 3 proja · ~/dev/ProjectA · opus-5.5 xhigh · ctx ▕██████░░░░▏58% · screen 7349.proja ─────────────┤
│ PLAN  Audio mixer ▸ 5 Verify ▸ 5.2 Run full build                              ▰▰▰▰▰▰▰▰▰▱ 9/10      │
│ NOW   ⚙ build_project  cmake --build build -j8        12m04s   unit run-p360222 ▕█████████░▏6.1/6.5G │
│ SAID  "Mixer bus wired; running the full build before the verification gate."                       │
│ 60m   ████████▒▒▒▒██████████░░░░██████████████████▒▒▒▒▒▒▒▒████████   working █  waiting on you ▒  idle ░ │
╰ 1-9/↑↓ select  ⏎ detail  p prompt  x abort  a attach  v peek  n new  r resume  c close  u usage  ? ──╯
```

Compact (< 100 cols) drops MEM, API/min and the plan title:

```
 pi-dash  ⠹3 ◆1 ✖1   5h ▕██████░░▏24%   cpu 63%   12:47
 1 blog    ⠹ bash 4m    ▰▰▰▰▱▱  ▂▅▇█ 1.8c  $4.1
 2 cli     ⠼ think 38s  ▰▰▱▱▱▱  ▁▁▂▂ 0.2c  $1.0
▶3 proja   ⠧ build 12m  ▰▰▰▰▰▱  ▇▇██ 3.9c  $7.9
 4 webapp  ◆ you 8m     ▰▰▰▰▰▰  ▁▁▁▁ 0.0c  $2.4
```

### 4.3 Detail (`⏎`)

```
╭─ 3 proja ─ ~/dev/ProjectA ─ opus-5.5 · xhigh ─ ctx ▕██████░░░░▏58% ─ up 14h ─ screen 7349.proja ──╮
│ PLAN  Audio mixer                                                              ▰▰▰▰▰▰▰▰▰▱ 9/10      │
│  ✔ Investigate  ✔ Design  ✔ Core  ✔ Wire UI  ▶ Verify ▸ 5.2 Run full build                          │
│ CPU cores · 30m            pi ▓ indirect ▒  │ MEMORY · 30m                pi ▓ indirect ▒          │
│ 4┤          ▒▒▒▒▒▒▒▒▒▒▒                     │ 10G┤           ▒▒▒▒▒▒▒▒▒▒▒                       │
│ 2┤   ▒▒▒ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                    │  5G┤ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                      │
│ 0┼▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                  │  0 ┼▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                      │
│ API tokens/min · 60m   ⣀⣠⣤⣶⣿⣿⣶⣤⣀⣀⣠⣤⣀        │ TOP CONSUMERS                   cpu    mem     │
│ direct $7.12 ▕████████████████▏              │ run-p360222  r2-gates.sh       3.1c   6.1G    │
│ indirect $0.76 ▕██▏  cache hit 91%           │ pi (self)                      0.8c   2.3G    │
│                                              │ tsserver                       0.0c   0.4G    │
│ TOOLS · 60m  ⚙bash ✔  ⚙edit ✔  ⚙build_project …                                                    │
╰ p prompt  x abort  a attach  v peek  c close  Esc back ──────────────────────────────────────────────╯
```

### 4.4 Usage (`u`, Phase 4)

```
╭─ usage ─ today ▸ 7d ▸ 30d ───────────────────────────────────────────────────────────────────────────╮
│ anthropic 5h ▕████████░░░░░░░░░░░░░░░░▏24% ↻2h13m   share (est.)  proja █████ blog ███ cli █ other ░ │
│ anthropic wk ▕████████░░░░░░░░░░░░░░░░▏26% ↻4d9h    codex wk ▕░░░░░░░░░░░░░░░░░░░░▏0% ↻6d2h          │
│ COST BY SESSION ($ API-equiv.)          │ TOKENS BY HOUR (stacked by session)                        │
│ proja   ██████████████████████  7.88    │ ▁▂▂▃▅▇█▇▆▅▃▂▃▅▆▇█▆▄                                        │
│ blog    ███████████▌            4.12    │ 00    04    08    12    16    20                           │
│ webapp  ██████▋                 2.40    │ BY MODEL  opus-5.5 ████████████ 86%  gpt-6 ██ 14%          │
│ (ended) █▌                      0.55    │ CACHE HIT ▕██████████████████░░▏91%                         │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

### 4.5 Overlays

- **Composer** (`p`): pi-tui `Editor`. The header shows the target and the mode. When the
  session is working, `Tab` switches between **steer** and **follow-up**. *Updated:* the
  default is steer, which matches what Enter does inside pi. Slash commands are rejected
  with a hint to attach. `⏎` sends, `Esc` cancels.
- **Launcher** (`n`): project picker (recent project directories read from the session
  file headers) or a typed directory path. It launches a managed screen (D6).
- **Resume** (`r`): sessions of the selected project with name or first prompt, last
  activity and 30-day usage. On an exited row, that row's own session is listed first and
  the resumed session takes over its slot. Sessions already open elsewhere are marked.
- **Close** (`c`) / **Recycle** (`C`: close + new in same project, the most common loop):
  confirm, graceful shutdown, then launch.
- **Peek** (`v`): read-only mirror of the pi screen via `screen -S <sty> -p <window> -X hardcopy`
  into `$XDG_RUNTIME_DIR/pi-dash/peek-<pid>.txt`, refreshed 1 s. For dialogs and
  "what is it doing exactly".
- **Attach** (`a`): stop the TUI, run `screen -rx <sty> -p <window>` with inherited stdio,
  and restart the TUI after `Ctrl-a d`. *Updated:* this is a multi-display attach, so the
  session stays visible in its original terminal (and on any other host attached to that
  screen) while you use it from the dashboard tab. The dashboard tab works like any other
  `screen -rx` viewer. Run pi-dash in a plain tab, not inside screen, to avoid nested
  screen key prefixes.

### 4.6 Keymap

`1-9`/`↑↓`/`jk` select · `⏎` detail · `Esc` back · `p` prompt · `x` abort (confirm) ·
`a` attach · `v` peek · `n` new · `r` resume · `c` close · `C` recycle · `u` usage ·
`?` help · `q` quit.

## 5. Repository layout and tooling

```
GatPi-Fleet/
  package.json          # pi package manifest (bridge) + bin pi-dash; runtime dep: @earendil-works/pi-tui;
                        # dev: pi-coding-agent / pi-ai (types, test fixtures), typescript
  tsconfig.json         # strict, erasableSyntaxOnly (Node runs .ts directly), noEmit
  bin/pi-dash           # launcher
  config/screenrc       # one-window screenrc for dashboard-launched sessions
  src/protocol/         # message types, framing, usage math, PROTOCOL_VERSION
  src/bridge/index.ts   # pi extension (loaded by pi via jiti; node builtins only)
  src/dashboard/
    main.ts
    collectors/         # bridges (socket hub), procs (/proc + cgroups + attribution), gpu, quota
    model/              # store (rows, slots, history), series, status derivation
    actions/            # screen launch/attach/peek, project + session listings
    usage/              # byte-level extraction, incremental indexer, worker, queries
    ui/                 # app (keys/actions), charts, overlays, format, theme, views/
  test/                 # node:test unit, attribution and render tests; e2e/ with real pi
  PLAN.md, README.md
```

Cross-repo change (GatPi-Harness, D5): the roadmap extension sends every state it presents
(`session_start`, reloads and each `commit()`) through `present()`, which renders the widget
and emits `roadmap:changed` with `roadmapSnapshot()` from `roadmap-state.js`.
*Updated:* no `roadmap:request`. The bridge subscribes when it loads, before any
`session_start` runs, so it always sees the first emit (verified with the real extension).

## 6. Delivery phases

Each phase ends with a working tool; later phases add capability on top.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Spikes** (≈1 d) | Throwaway checks of risky assumptions: socket server in an extension survives `/new` re-instantiation; `sendUserMessage` from a socket callback shows in the TUI transcript, idle and while streaming (`steer`/`followUp`); `ctx.abort()`/`ctx.shutdown()` from callbacks; time to sum usage over `getEntries()` on the 335 MB session; which subagent path carries usage; `hardcopy` of a pi screen is legible; pi-tui stop → `screen -x` → restart round-trip; whether `nvidia-smi pmon` reports per-process SM% on this host's GPU (it printed `-` for the one process seen) | Each item answered yes/no with evidence recorded in this file; plan adjusted before Phase 1 |
| **1. Status board** (≈2–3 d) | protocol; bridge (identity, phase/activity, usage totals, context %, last prompt/said, plan via D5 incl. harness change); dashboard overview + detail header; unbridged discovery via `/proc`; slots; alert highlight on needs-you/error | With 3+ real sessions, the board shows correct working/needs-you/error within 1 s and correct plan progress; restarting the dashboard loses nothing |
| **2. Control** (≈2–3 d) | composer (prompt/steer/follow-up), abort, close, recycle, launcher, resume, peek, attach | A full prompt → wait → prompt loop and a close/new cycle done entirely from the dashboard |
| **3. Resources** (≈2–3 d) | proc sampler, systemd-unit cgroups, job + environ attribution, GPU, host header; CPU/MEM columns, detail charts, top consumers; stalled? detection | A `build_project` run shows up as indirect CPU/MEM on the right session; numbers within ±10 % of `top`/`systemd-cgtop` |
| **4. API usage** (≈2–3 d) | live direct/indirect usage series, subagent tailing, quota gauges + share estimate, usage view, history indexer + cache retention | Session $/tokens match `/session` in pi; quota matches the failover state file; usage view opens < 2 s after first index |
| **5. Polish** (≈1–2 d) | activity lanes, responsive widths (80/100/120+), help overlay, error/empty states, install docs (`pi install <repo>`, `bin/pi-dash` on PATH) | Daily-driver use for a week without returning to tab-hopping for status checks |

## 7. Testing and verification

- **Protocol**: unit tests for framing (split on `\n` only, partial chunks) and version
  rejection.
- **Bridge**: *Updated:* end-to-end against the real interactive `pi` binary running in a
  detached screen, with a local scripted-model extension (`test/fixtures/`): no network,
  no cost, and it exercises the real extension loading path. Covered: working→idle
  transitions, usage totals, prompt/steer delivery, abort, errors, rename, `/new`
  replacement, and shutdown with socket and screen cleanup.
- **Attribution**: real processes, not mocks — spawn a busy child, a `setsid` orphan with
  a `PI_SESSION_ID`, and (when available) a `systemd-run --user` unit; assert each lands in
  the right bucket.
- **UI**: render tests for chart components and all three views at 80, 100 and 140
  columns (no line exceeds the width, a glyph is present for each status). Interactive
  acceptance was done by driving the real TUI in a tmux pane (§12).
- **Manual acceptance** per phase against the live screens; record results here.
- **Budgets** measured at the end of Phases 3 and 5.

## 8. Budgets and retention

- Dashboard: < 2 % of one core average with 6 sessions; < 150 MB RSS.
- Bridge: < 0.5 % of one core added to pi; ≤ 4 patches/s per session.
- Disk: only `~/.cache/pi-dash/usage-index.json` (derived, pruned to 30 days, expected
  < 5 MB) and per-session peek files in `$XDG_RUNTIME_DIR` (tmpfs, deleted on close).
  Sockets removed on shutdown; stale sockets (dead pid) removed by the dashboard.
- No logs are written. *Updated:* no `--debug` flag; nothing needed it.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| pi extension API changes (pi updates often) | Only documented events/APIs; protocol version handshake; bridge integration tests rerun after each pi update |
| Blocking extension dialogs (`ctx.ui.confirm` from policy gates) are invisible to other extensions | "stalled?" derivation + peek + attach |
| Prompt sent while the user is typing in the attached pi | `sendUserMessage` does not touch the editor buffer; composer shows the target's phase first |
| `screen -rx` resizes the window to the newest display | Expected; pi re-renders. Documented |
| Pid reuse / stale sockets | `(pid, starttime)` keys; liveness check before connecting |
| Large session files | Bridge uses pi's in-memory entries; dashboard only tails from offsets in a worker |
| Per-session quota share is approximate | Labelled "est."; the authoritative number is the provider's window % |
| Cross-repo change in GatPi-Harness | Small, isolated emit in `commit()`; dashboard shows "no plan" until it lands |

## 10. Open questions (resolved)

1. Keep GNU screen: **yes**.
2. Attach: **multi-display `screen -rx`**. The session stays visible in its own screen
   and on any other host while the dashboard tab shows it. Peek (`v`) covers looking
   without taking the terminal.
3. Show $: **yes**, next to tokens and quota %.
4. Default send mode while working: **steer** (same as Enter in pi); `Tab` switches to
   follow-up.
5. Desktop notifications: **no**. Alerts are visual only.
6. Bridge location: **this repo**, installed as a local pi package
   (`pi install <repo>`), because it shares the protocol module with the dashboard.

## 11. Later ideas (not in scope)

- Goal/automation-loop/run-deck badges via the same `pi.events` pattern as the roadmap.
- Classify the last assistant message (done / asks a question / blocked) to sharpen
  "needs you" — costs tokens, opt-in only.
- Model/thinking switch and `/compact` from the dashboard.
- Broadcast a prompt to several sessions.

## 12. Results

**Phase 0 spikes** (real pi 0.84.1 in a detached screen, scripted model):

| Question | Answer |
|---|---|
| Socket server survives `/new` / `/resume` | Yes. The old instance sends `bye {reason}` and removes its socket; the new instance listens at the same `<pid>.sock`. The dashboard reconnects within 1 s |
| `sendUserMessage` from a socket callback | Shows in pi's transcript like a typed prompt, both idle and while working (`steer`) |
| `ctx.abort()` / `ctx.shutdown()` from callbacks | Both work. Shutdown waits for idle, then `bye quit` |
| Abort reporting | pi persists the interrupted turn as `stopReason: "error"`. The bridge treats errors raised while the abort signal is set as user aborts, not failures |
| Usage pass over `getEntries()` | 6.5 ms for a 119 MB / 8 122-entry session (pi's own load of that file takes 6.1 s) |
| Subagent usage path | GatPi-Harness subagents write sessions to `<cwd>/.pi/subagents/rpc-sessions/<id>/`, with the parent in `records/<id>.json` |
| `hardcopy` peek | Legible, refreshes every 1 s |
| TUI stop → `screen -rx` → restart | Works. A forced redraw is needed after restart (renders requested while stopped are dropped) |
| Per-process GPU SM% | Not reported on this host's GPU (`-`), so dropped |
| Default `~/.screenrc` | Opens extra windows, so dashboard-launched sessions use `config/screenrc` |

**Verification:**

- `npm run check` (strict tsc): clean. `npm test`: 18 tests (protocol, usage extraction,
  indexer incl. rewrite and retention, status/store/quota/GPU parsing, attribution with
  real busy and short-lived children, `PI_SESSION_ID` orphans and a real `systemd-run --user`
  unit, renders at 3 widths). `npm run test:e2e`: 9 tests against the real `pi`.
- GatPi-Harness `tests/roadmap-*.test.js`: pass (snapshot shape, publish wiring).
- The real GatPi-Harness roadmap extension was observed feeding the bridge's `plan`.
- Interactive acceptance in a tmux pane: compose (idle, steer, follow-up), abort, close,
  recycle (slot kept), new, resume, peek, attach + `Ctrl-a d`, rename, dismiss, detail,
  usage and help views, and 80/100/130-column layouts.
- Accuracy: sampler CPU and RSS matched `top` within 1 % on the live sessions. Usage
  extraction matched a full JSON parse exactly on a real 5.7 MB session.
- Usage index: the first scan of 113 files / 3.6 GB (30 days) took 17 s in the worker
  thread, and a rescan takes 34 ms. The cache is 175 KB.
- Budgets (130×34, 7 sessions, 60 s average): dashboard 1.5 % of one core and 140 MB RSS,
  after making cell fitting measure before truncating (it was 2.3 %). Bridge: patches
  coalesced to 4 Hz, with no file I/O after `session_start`.
