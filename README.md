# pi-dash

One terminal tab to watch and drive every running [pi](https://pi.dev) session.

- **State at a glance**: working (with the current tool or thinking/writing), waiting for you,
  error / rate limited, stalled, exited. When a session starts needing you, its row is highlighted,
  and `Tab` jumps to the session that has waited longest. An activity lane shows the last hour,
  even right after pi-dash starts.
- **Plan progress**: the active roadmap step and a progress bar (from the GatPi-Harness roadmap), and
  how full each session's context window is (CTX).
- **Resources**: CPU, memory and GPU memory per session, split into the pi process itself (▓) and
  everything it started (▒): tool commands, LSP servers, subagents, background jobs, `build_project`
  systemd units, and detached processes that carry the session's `PI_SESSION_ID`. Running
  `bg_run` jobs and subagents are listed by name (BG).
- **API usage**: tokens and API-equivalent $ per session (direct, nested tool LLM calls,
  subagents), per-minute trends, subscription quota windows with an estimated per-session share,
  and a usage view for today / 7 days / 30 days in $ or tokens. Sessions on models without a
  price show tokens (`173Mt`) instead of an empty $.
- **Conversation**: the last prompt, the recent tool calls with their arguments, the latest reply
  (previewed under the session list; whole, as Markdown, scrollable, or full screen), and the
  suggested next prompt from the GatPi-Harness prompt suggestions.
- **Ask a session about itself**: "what are you doing right now?", "why did you change X?". The
  session's own model answers from the same context its requests carry (system prompt, tools, the
  whole conversation since the last compaction with its summary, tool calls and their output) plus
  what has not reached the transcript yet (running tools and their output so far, the reply being
  written). Nothing is added to the session and its run is not interrupted.
- **Hermes advisor**: a redacted cross-session management view asks Hermes for typed advice cards
  (or uses local rules if Hermes is unavailable), lets you confirm actions, and records
  shown/accepted/dismissed/executed outcomes so future advice can adapt.
- **Control without switching tabs**: prompt (steer or follow-up while working, or take the
  suggested next prompt), abort, compact, switch model or thinking level, close,
  close-and-restart, new session, resume, rename, live read-only peek, and full attach.

## Requirements

- Linux (`/proc`, cgroup v2), Node ≥ 22.19 (runs the TypeScript sources directly), GNU screen.
- pi ≥ 0.84 with the bridge extension installed (below).
- Optional: `nvidia-smi` for GPU stats, GatPi-Harness for roadmap progress and next-prompt
  suggestions, the `pi-multi-account` failover state for quota gauges, `hermes` on PATH for the
  advisor's model-refined cards (local rule cards still work without it).

## Install

```sh
cd ~/dev/GatPi-Fleet && npm install          # dashboard dependencies
pi install /home/user/dev/GatPi-Fleet      # bridge extension, loaded by new pi sessions
ln -s /home/user/dev/GatPi-Fleet/bin/pi-dash ~/.local/bin/pi-dash
```

`pi install <path>` adds the local package to `~/.pi/agent/settings.json` without copying it. The
bridge loads only in interactive pi sessions, not in `pi -p` or RPC subagents. Sessions started
before the install show up as `? no bridge` (resources only) until they are restarted or resumed.

After an update that changes the bridge protocol, sessions still running the old bridge show
`✖ bridge v2: /reload it`. Restart pi-dash, then type `/reload` in each such session (attach with
`a`): pi loads the current bridge and pi-dash connects to it.

## Use

Run `pi-dash` in a plain terminal tab (not inside screen). Sessions are discovered automatically.

| Key | Action |
|---|---|
| `1`–`9`, `↑↓`, `j k` | select a session (slots stay stable) |
| `Tab` | select the next session that needs you (needs you, error, stalled; longest waiting first) |
| `⏎` / `Esc` | detail view / back |
| `p` | prompt the session; while it works, `Tab` switches between **steer** (default; delivered after the current tool) and **follow-up** (after the run). When it is idle, the suggested next prompt shows under the empty editor and `Tab` takes it |
| `i` | ask the session a side question about its work (full screen: earlier questions and answers above, the editor below; `PgUp` `PgDn` scroll). One question at a time; closing the view does not cancel it, and the footer says when the answer arrives |
| `H` | Hermes advisor: refresh cross-session advice cards, dismiss noisy cards, or confirm a proposed ask / prompt / compact / notification / proposal action |
| `x` | abort the current run |
| `Z` | compact the conversation (idle sessions; asks first) |
| `M` / `T` | switch the model / thinking level (pi limits the level to what the model supports) |
| `s` | read the latest reply full screen (`↑↓` `PgUp` `PgDn` `Home` `End` scroll, `p` prompt). Clicking SAID in the detail view does the same |
| `PgUp` `PgDn` | scroll SAID in the detail view (the mouse wheel over it works too) |
| `v` | peek: live read-only mirror of the session's screen (catches dialogs that only show in pi) |
| `a` | attach with `screen -rx`; the session stays visible in its original terminal too. `Ctrl-a d` returns |
| `n` | new session: pick a recent project or type a directory path |
| `r` | resume a session of the selected project (also how you restart an exited row) |
| `c` / `C` | close / close and start a fresh session in the same project and slot |
| `R` | rename the session |
| `d` | dismiss an exited row |
| `u` | usage view (`t` / `w` / `m`: today, 7 days, 30 days; `$`: cost or tokens) |
| `?` | help and legend |
| `q` | quit (sessions keep running) |

Abort, compact, close and close-and-restart ask before they act. Resume also asks when the project has a
live session without a bridge: pi-dash cannot see which session file that pi has open, and two pi
processes writing one file mix its history. Quit asks while a close-and-restart is still waiting
for its session to exit, because only a running pi-dash starts the replacement.

Sessions started from the dashboard run pi in a detached screen named `pi-<project>` using
[`config/screenrc`](config/screenrc) (your usual settings, but only one window). When pi exits,
its screen ends. Existing screens you started yourself are picked up as they are.

Slash commands only work inside pi: attach (`a`) to use them.

pi-dash takes mouse input for clicks and the wheel. Dragging selects text and copies it with
OSC 52; where the terminal does not support that, hold `Shift` while dragging to use the
terminal's own selection.

## How it works

```
pi (in screen) ── bridge extension ── $XDG_RUNTIME_DIR/pi-dash/<pid>.sock ──┐
pi (in screen) ── bridge extension ── $XDG_RUNTIME_DIR/pi-dash/<pid>.sock ──┼── pi-dash
/proc, cgroups, nvidia-smi, session files, provider-failover-state.json ────┘
```

- `src/bridge/`: pi extension. It publishes session state (snapshot, then coalesced patches) and runs
  commands over a per-process unix socket (mode 0600, directory 0700).
- `src/protocol/`: LF-delimited JSON messages shared by both sides.
- `src/dashboard/`: the TUI (built on `@earendil-works/pi-tui`), collectors, and usage index. It
  holds no durable state; restarting it loses nothing.
- The Hermes advisor (`H`) runs in pi-dash, not in the bridge. It sends Hermes only a redacted
  dashboard snapshot: session labels, cwd basenames, statuses, timers, activity names, context
  fill, roadmap titles, resource totals, current prompt suggestions, and errors. It does not send
  `lastSaid`, ask answers, raw transcripts, full prompts, or tool output. Hermes must return typed
  action cards, and pi-dash executes only confirmed cards through the same bridge commands you can
  trigger manually. If the Hermes CLI is missing, times out, or returns invalid JSON, local
  deterministic cards are shown instead.
- An ask (`i`) runs in the bridge, inside the pi process: it rebuilds the request the session's
  model would get (`buildSessionContext` + `convertToLlm`, the current system prompt and active
  tools), answers the still-running tool calls with "still running, output so far", adds a status
  block and the question, and streams the answer through the model's provider with the session's
  model, thinking level and session id. The request therefore shares the provider's prompt cache
  with the session: answers typically read 99% of their input from cache (about $0.02 for a 75k
  token context on Claude). Answers live in the bridge's memory for the life of the pi process.
- Roadmap progress comes from the GatPi-Harness roadmap extension, which emits `roadmap:changed` on
  pi's extension event bus. The suggested next prompt comes the same way from the GatPi-Harness
  prompt-suggestions extension (`prompt-suggestion:changed`).

Files written: the usage index cache at `~/.cache/pi-dash/usage-index.json` (derived, keeps
30 days, about 200 KB), Hermes advisor feedback at
`~/.cache/pi-dash/hermes-advisor-events.jsonl`, and short-lived peek captures and sockets in
`$XDG_RUNTIME_DIR/pi-dash/`.
The first start indexes recent session files in a background thread; on this machine that took
about 17 s for 3.6 GB, and later scans take milliseconds.

$ figures are pi's API-equivalent cost. With subscription logins, the quota windows are the
limit that actually applies. Models without a price in pi report no cost: they count in tokens,
and their quota share is estimated from tokens. LLM calls that extensions make outside the session
transcript are not counted. That includes asks (`i`): each answer shows its own tokens, cache
share and cost, but they are not added to the session's totals.

## Development

```sh
npm run check      # tsc (strict, type stripping compatible)
npm test           # unit, attribution (real processes / systemd units) and render tests
npm run test:e2e   # real interactive pi in a detached screen with a local scripted model
```

The e2e test needs `pi` and `screen` on PATH. It uses an isolated agent directory, does not
call any network or API, and cleans up after itself. `npm run` puts `node_modules/.bin` first on
PATH, so `npm run test:e2e` runs the dev dependency's pi; `node --test 'test/e2e/*.test.ts'` runs
the pi you have installed.
