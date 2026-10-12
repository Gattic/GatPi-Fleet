# pi-dash

One terminal tab to watch and drive every running [pi](https://pi.dev) session, on this machine
and on the other machines of your network (over ssh).

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
  subagents), per-minute trends, separate multi-login account cooldowns,
  and a usage view for today / 7 days / 30 days in $ or tokens. Anthropic and Codex subscription
  quotas show account bars, remaining percentages and provider reset countdowns; unavailable or stale
  readings are labelled explicitly. Sessions on models without a price show tokens (`173Mt`) instead of an empty $.
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
  close-and-restart, new session, resume, rename, live read-only peek, full attach, and common
  Git project shortcuts.

## Requirements

- Linux (`/proc`, cgroup v2), Node ≥ 22.19 (runs the TypeScript sources directly), GNU screen.
- pi ≥ 1.0 with the bridge extension installed (below).
- Remote hosts (optional): key-based ssh from this machine, and on the host GNU screen, pi, and
  Node ≥ 22.19 on its login PATH or under `~/.nvm` (see [Remote hosts](#remote-hosts)).
- Optional: `nvidia-smi` for GPU stats, GatPi-Harness for roadmap progress and next-prompt
  suggestions, the harness's `multi-login` state for account cooldowns, `hermes` on PATH for the
  advisor's model-refined cards (local rule cards still work without it).

## Install

```sh
cd ~/dev/GatPi-Fleet && npm install          # dashboard dependencies
pi install /home/user/dev/GatPi-Fleet      # bridge extension, loaded by new pi sessions
ln -s /home/user/dev/GatPi-Fleet/bin/pi-dash ~/.local/bin/pi-dash
ln -s /home/user/dev/GatPi-Fleet/bin/pi-dash-host ~/.local/bin/pi-dash-host   # remote hosts
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
| `g` | Git shortcuts for the selected project (`u` update/pull, `s` send/push, `b` branch, `v` view `git status` full screen, `c` AI commit-review prompt, `r` refresh) |
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
| `d` | dismiss an exited row (here, in the gateway and on the phone; dismissing it on the phone removes it here too) |
| `u` | usage view (`t` / `w` / `m`: today, 7 days, 30 days; `$`: cost or tokens) |
| `?` | help and legend |
| `q` | quit (sessions keep running) |

Abort, compact, close and close-and-restart ask before they act. Git pull runs `git pull --ff-only`
and asks first; push always asks first and can create an upstream only when there is exactly one
remote; branch switching uses local branches and requires a clean working tree. The commit shortcut
opens the standard AI prompt to review the changes and commit if everything looks good; pi-dash does
not commit directly. Resume refuses when the project has a live session without a current bridge: pi-dash
cannot see which session file that pi has open, and two pi processes writing one file mix its
history. All manager-created resumes use a shared exclusive reservation; resolve unknown
ownership locally instead of overriding it. Quit asks while a close-and-restart is still waiting for its session to exit, because only a
running pi-dash starts the replacement.

Sessions started from the dashboard run pi in a detached screen named `pi-<project>` using
[`config/screenrc`](config/screenrc) (your usual settings, but only one window). When pi exits,
its screen ends. Existing screens you started yourself are picked up as they are.

`Stalled` is a tentative tool-only warning after three minutes without Pi events and with little
local CPU activity. A quiet tool waiting on a network or user dialog can trigger it; it is not proof
that the session is stuck. Remote model work (including thinking and compaction) stays working
through silent periods, since local CPU does not measure provider progress.

Slash commands only work inside pi: attach (`a`) to use them.

pi-dash takes mouse input for clicks and the wheel. Dragging selects text and copies it with
OSC 52; where the terminal does not support that, hold `Shift` while dragging to use the
terminal's own selection.

## Remote hosts

pi-dash also shows and drives the pi sessions of other machines. It reaches them over ssh, so a
host needs nothing that listens on the network, and adding a machine is one command run here:

```sh
pi-dash-host add box00 box01 boxhome    # install or update, then list them
pi-dash-host list                       # which hosts answer, and which machine each is
pi-dash-host remove box01              # stop listing it (its install stays)
```

A host is an ssh destination, usually a `~/.ssh/config` alias. `add` copies this checkout's
`package.json`, `bin`, `config` and `src` (the files git tracks or would track; ignored files such
as `.pi/` stay here) to `~/.local/share/pi-dash` on the host (replacing an earlier copy), registers its bridge with the host's pi (`pi install`), checks that the relay
answers, and adds the host to `~/.config/pi-dash/hosts.json` (`{"hosts": ["box00", …]}`; you can
edit it by hand). Run `add` again after updating pi-dash here: an older or newer host shows
`✖ offline … run pi-dash-host add HOST`. pi sessions already running on a host show `? no bridge`
until `/reload`; `add` refuses this machine itself, whose sessions are already shown.

Remote sessions are listed as `name@host`. Everything in the table above works on them: commands
and asks go to their bridge, `v` peeks and `a` attaches over ssh (`ssh -t HOST screen -rx`), `g`
runs git on the host, and `n` first asks where the new session should run. The `HOSTS` line shows
each host's link (`●` online, with its CPU and memory when there is room, `…` connecting, `✖`
offline with the reason) and pi-dash reconnects on its own, backing off up to a minute. While a
host is unreachable its bridged sessions show `… reconnecting`.

A host's relay runs as you on that host, like its bridges. pi-dash still treats what it sends as
another machine's: text is shown without terminal control sequences, and a relay that sends
something malformed, does not greet within 30 s, or stops answering (30 s; 150 s for git) loses its
link and is reconnected, without affecting the other hosts.

The mobile gateway (`pi-dash-server`) reads the same `hosts.json` when it starts and opens its own
links to the hosts, so the phone shows and drives their sessions too and offers their projects for
new sessions. Its service therefore needs the same non-interactive ssh as pi-dash (keys, or an ssh
agent its environment can reach); restart it after changing the host list.

What stays local: the usage view (also the phone's Usage tab, for the gateway's machine) and
`today $` count this machine's session files (each remote session's own $ comes from its bridge,
without its subagents), and account status uses this machine's logins.

## How it works

```
pi (in screen) ── bridge extension ── $XDG_RUNTIME_DIR/pi-dash/<pid>.sock ──┐
pi (in screen) ── bridge extension ── $XDG_RUNTIME_DIR/pi-dash/<pid>.sock ──┼── pi-dash
/proc, cgroups, nvidia-smi, session files, multi-login-state.json ─────────┤
                                                                            │
remote host: bridges, /proc, screen, git ── pi-dash-relay ══ ssh stdio ═════┘
```

- `src/bridge/`: pi extension. It publishes session state (snapshot, then coalesced patches) and runs
  commands over a per-process unix socket (mode 0600, directory 0700).
- `src/protocol/`: LF-delimited JSON messages shared by both sides.
- `src/manager/`: shared headless runtime, collectors, model, usage index and nonterminal actions.
- `src/dashboard/`: the TUI (built on `@earendil-works/pi-tui`), terminal-only interactions and Hermes.
- `src/server/`: authenticated HTTPS/WSS intranet gateway with typed inputs and command receipts.
- `src/relay/`: `pi-dash-relay`, which pi-dash starts on each remote host over ssh. It runs the same
  bridge hub, process sampler and actions there and speaks LF-delimited JSON on stdin/stdout:
  bridge states as a snapshot then patches, and typed requests (command, sample, peek, projects,
  sessions, launch, git). `bin/pi-dash-relay` takes PATH from a login shell and picks a Node that
  strips types. `src/manager/remote/` is pi-dash's side; `src/hosts/` is `pi-dash-host`.
- `android/`: native Kotlin/Compose dashboard and optional direct G1 display; see the
  [setup, security and build guide](docs/ANDROID.md) and [acceptance status](docs/ANDROID-ACCEPTANCE.md).
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
`$XDG_RUNTIME_DIR/pi-dash/` (on remote hosts too; the relay removes its captures when it ends).
Dismissed exited sessions are empty files in `$XDG_RUNTIME_DIR/pi-dash/dismissed/`, which is how
pi-dash and the gateway (separate processes) drop the same rows; entries older than a week are
removed.
`pi-dash-host` writes `~/.config/pi-dash/hosts.json` here, and on each host it adds installs
`~/.local/share/pi-dash` (about 500 KB) and its entry in pi's `settings.json`.
The first start indexes recent session files in a background thread; on this machine that took
about 17 s for 3.6 GB, and later scans take milliseconds.

$ figures are pi's API-equivalent cost, not subscription balances. [Account quotas](docs/QUOTAS.md)
come from read-only Anthropic/Codex usage endpoints using local Pi OAuth logins, including account aliases.
Bars show the allowance **left**, with provider reset timers. Failed/old readings are explicitly stale;
missing or unsupported data never becomes 100% available. The old `provider-failover-state.json` stays ignored.
Account cooldowns come separately from `multi-login-state.json`: local failover timers, not provider resets.
Quota probes never change logins, cooldowns or model selection. Models without a price count in tokens.
LLM calls that extensions make outside the session transcript are not counted. That includes asks (`i`): each answer shows its own tokens, cache
share and cost, but they are not added to the session's totals.

## Android and Even Realities G1

The optional `pi-dash-server` gateway exposes session management to the Android companion over
local HTTPS/WSS. G1 glasses are a read-only glance surface; actions remain on the phone. There is
no cloud, microphone, arbitrary shell endpoint, or automatic command replay. Use the
[Android guide](docs/ANDROID.md) for pairing, deployment, build/install and recovery.
Physical phone/G1 acceptance is still required before relying on screen-off monitoring.

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
