# pi-dash

One terminal tab to watch and drive every running [pi](https://pi.dev) session, on this machine
and on the other machines of your network (over ssh).

- **State at a glance**: working (with the current tool or thinking/writing), waiting for you,
  error / rate limited, stalled, exited. When a session starts needing you, its row is highlighted,
  and `Tab` jumps to the session that has waited longest. Running background jobs and subagents
  keep a session working rather than waiting for you, in both pi-dash and Android.
  An activity lane shows the last hour,
  even right after pi-dash starts.
- **Crash recovery**: interrupted sessions survive dashboard restarts. Press `e` to find them across
  projects and connected hosts, then confirm a resume of the exact saved conversation.
- **Plan progress**: the active roadmap step and a progress bar (from the GatPi-Harness roadmap), and
  how full each session's context window is (CTX). The read-only **Roadmap Viewer** (`o`, or
  **Open roadmap** in Android session detail) shows nested tasks, statuses, notes and separate
  root-outcome/workflow progress, updating with the selected session.
- **Resources**: CPU, memory and GPU memory per session, split into the pi process itself (▓) and
  everything it started (▒): tool commands, LSP servers, subagents, background jobs, `build_project`
  systemd units, and detached processes that carry the session's `PI_SESSION_ID`. Running
  `bg_run` jobs and subagents are listed by name (BG), and the **jobs page** (`J`) shows every
  running job and subagent across sessions with its age, CPU/memory when there is room, and the command or task it runs.
- **API usage**: tokens and API-equivalent $ per session (direct, nested tool LLM calls,
  subagents), per-minute trends, separate multi-login account cooldowns,
  and a usage view for today / 7 days / 30 days in $ or tokens, across this machine and your
  [remote hosts](#remote-hosts) with a per-host share. Anthropic and Codex subscription
  quotas show account bars, remaining percentages and provider reset countdowns; unavailable or stale
  readings are labelled explicitly. Sessions on models without a price show tokens (`173Mt`) instead of an empty $.
- **Context breakdown**: each session's model context as pi measures it (tokens, window, fill,
  compact threshold) plus an estimated composition (system prompt, tool declarations, injected,
  user, assistant, tool results, summaries) and an explicit `unattributed` residual. The detail
  view draws it as a stacked bar; the **context view** (`K`) adds per-session rows, a cumulative
  composition, weighted mean fill and `open` / `today` / `30d` scopes. Totals are measured; parts
  are pi's chars/4 estimates and are labelled `est.`. An unknown total (for example right after
  compaction) stays unknown, never zero. Ended sessions show their last-known context and window;
  composition is live-only.
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

- Linux (`/proc`, cgroup v2), Node ≥ 22.19 (runs the TypeScript sources directly), GNU screen,
  `flock` (util-linux) for shared Anthropic usage polling.
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
| `o` | open the selected session's read-only Roadmap Viewer (`↑↓` / `PgUp` / `PgDn`, mouse wheel, `Home` / `End` to scroll; `Esc` / `q` closes) |
| `s` | read the latest reply full screen (`↑↓` `PgUp` `PgDn` `Home` `End` scroll, `p` prompt). Clicking SAID in the detail view does the same |
| `PgUp` `PgDn` | scroll SAID in the detail view (the mouse wheel over it works too) |
| `v` | peek: live read-only mirror of the session's screen (catches dialogs that only show in pi) |
| `a` | attach with `screen -rx`; the session stays visible in its original terminal too. `Ctrl-a d` returns |
| `n` | new session: pick a recent project or type a directory path |
| `r` | resume the selected interrupted session (asks first), otherwise pick a session of its project |
| `e` | find interrupted sessions across projects and connected hosts; resume or dismiss a suggestion |
| `c` / `C` | close / close and start a fresh session in the same project and slot |
| `R` | rename the session |
| `d` | dismiss an exited row (here, in the gateway and on the phone; dismissing it on the phone removes it here too) |
| `u` | usage view (`t` / `w` / `m`: today, 7 days, 30 days; `$`: cost or tokens) |
| `K` | context view: per-session measured context, window, fill and composition; `a` cycles `open` / `today` / `30d`, `j` `k` / `PgUp` `PgDn` scroll, `⏎` opens detail, `Esc` back |
| `J` | jobs page: every running `bg_run` job and subagent, with its session, age, CPU/memory (wide terminals) and the command or task it runs (`j` `k` / `PgUp` `PgDn` scroll, `Esc` back) |
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

Sessions started from the dashboard run pi in a detached screen named `pi-<project>-<id>`.
When pi exits, its screen ends. Existing screens you started yourself are picked up as they are.

### Screen settings and colors

Configuration is selected **on the machine starting the session**, including remote relays:

1. Use `$XDG_CONFIG_HOME/pi-dash/screenrc` (normally `~/.config/pi-dash/screenrc`) if present.
   This host-owned file replaces the bundled defaults and survives `pi-dash-host add` updates.
   An unreadable, broken-symlink or non-file override fails the launch instead of silently falling back.
2. Otherwise detect `screen --version` and use [`config/screenrc-4`](config/screenrc-4) for
   Screen 4 or [`config/screenrc-5`](config/screenrc-5) for Screen 5. Both source the shared
   [`config/screenrc`](config/screenrc) settings via an absolute include path supplied by the
   launcher (`PI_DASH_SCREENRC_COMMON`), avoiding relative-include crashes in some Screen 5 builds.
   Screen 4 uses letter-based caption/status
   colors; Screen 5 uses numeric colors and enables truecolor. Other versions fail explicitly.

The defaults use `defbce off` so windows retain `TERM=screen-256color`. With BCE forced on,
Screen 4 can advertise `screen-256color-bce`; Ubuntu/Mint's `*-256color` Bash prompt check
then fails and `user@hostname` loses its green color. This is handled in Screen's configuration,
without changing the host's `.bashrc` or falsely advertising terminal capabilities.

To customize a host, create its override directory and copy the **settings only** from that
host's working screenrc into `screenrc`:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/pi-dash"
# Edit ${XDG_CONFIG_HOME:-$HOME/.config}/pi-dash/screenrc on the target host.
```

Do not copy `screen`, `chdir`, or `select` commands from `~/.screenrc` or `~/.screenrc-empty`:
those files may create workspace windows or select a different working directory. The override
is a normal Screen config, not a filtered file; keep it settings-only, using syntax supported
by the host's installed Screen. For Screen 4, for example:

```text
startup_message off
altscreen on
autodetach on
defscrollback 100000
term screen-256color
defbce off
vbell off
caption always "%{= bb}%{+b w}%n %t %h %=%l %H %c"
hardstatus alwayslastline "%-Lw%{= BW}%50>%n%f* %t%{-}%+Lw%<"
```

Do not use `truecolor on` or Screen 5's `15;4` color syntax on Screen 4. Pi-dash does not load
`~/.screenrc` or `~/.screenrc-empty` implicitly. To deploy a manager update, run
`pi-dash-host add HOST` from this checkout, then restart the local dashboard (and gateway, if
used) to reconnect with the new relay. Newly launched sessions use the selected config;
existing Screen processes retain their settings and need not be closed or reloaded.

`Stalled` is a tentative tool-only warning after three minutes without Pi events and with little
local CPU activity. A quiet tool waiting on a network or user dialog can trigger it; it is not proof
that the session is stuck. Remote model work (including thinking and compaction) stays working
through silent periods, since local CPU does not measure provider progress.

Slash commands only work inside pi: attach (`a`) to use them.

pi-dash takes mouse input for clicks and the wheel. Dragging selects text and copies it with
OSC 52; where the terminal does not support that, hold `Shift` while dragging to use the
terminal's own selection.

## Recover interrupted sessions

The overview shows an **interrupted sessions** banner when a tracked pi process has ended without
its bridge recording a graceful shutdown. Press `e`, select the session (name, ID and project),
choose **Resume**, and confirm. pi-dash starts `pi --session <saved-file>` in that project's directory
inside a new detached screen. Select the new row and press `a` to attach. On an existing interrupted
row, `r` goes straight to the confirmation and reuses its slot. Nothing resumes automatically.

The bridge writes private, small lifecycle records under
`$PI_CODING_AGENT_DIR/pi-dash/recovery/` (normally `~/.pi/agent/pi-dash/recovery/`). It records the
session ID, exact file (including custom session directories), project, name and process identity;
no conversation text is copied. This works even if pi-dash was closed when pi died, or pi-dash itself
was killed. Linux boot IDs and process start times distinguish a dead session from a reused PID.
An SSH disconnect or an unknown process identity is not treated as a crash. Offline hosts' recovery
suggestions become available once their relay reconnects and checks the host's processes.

Graceful quit, `/new`, `/resume` and `/fork` retire the old bridge's record. `/reload` keeps the record
until the replacement bridge starts, so a crash during reload remains recoverable without flagging
a live process. A newly started bridge retires dead predecessors of that saved session, including
after a manual resume or through a symlink alias. A launch
failure keeps the suggestion; starting screen alone does not clear it. Choose **Dismiss** in the
recovery menu to remove a suggestion without deleting the saved conversation. Unresolved records
stay until resumed or dismissed; resolved records are removed rather than accumulating history.
Dismissing an exited row also clears its recovery suggestion, including from the gateway. Dismissing
an interrupted remote row requires that host to be reachable so the dismissal can be saved there;
a known graceful exit can still be dismissed offline. Remote launches recheck process ownership on
the host, rather than trusting a potentially stale dashboard snapshot.
Existing duplicate-session checks and shared launch reservations still apply. Failed reservation
writes and project-directory failures release the reservation created by that attempt. If an entire screen
and its cleanup shell were killed, a stale reservation can require local inspection before removal;
pi-dash reports its path instead of risking two writers to the same conversation.

“Interrupted” means **no graceful shutdown was recorded**, not proven OOM. Pi resumes the persisted
conversation, not lost in-memory output or previously running tools. `--no-session` runs cannot be
recovered. Tracking starts when this bridge version is loaded: **restart pi-dash and `/reload` your
currently running pi sessions after this update**. Earlier crashes cannot be reconstructed reliably.
For remote hosts, run `pi-dash-host add HOST` to update the relay, then `/reload` their pi sessions.

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
`✖ offline … run pi-dash-host add HOST`. That message names both versions (`host runs relay v3 …,
this pi-dash v2`): when the host's is the newer one, this dashboard or gateway was started before the
update, so restart it; running `add` from the same old checkout would only downgrade the host. pi sessions
already running on a host show `? no bridge` until `/reload`; `add` refuses this machine itself, whose
sessions are already shown.

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

Usage counts every host. Each relay indexes its own host's pi session files (in a worker, so the
bridges are never delayed) and pushes the result, so the usage view, `today (all) $` and the phone's
Usage tab add up this machine and all the hosts, show each host's share (`BY HOST`), name remote
sessions `project@host`, and include a remote session's subagents in its total. A host that is
connecting or still on its first scan is marked `…`; one that is offline (`✖`) keeps the usage it reported
before. Each host keeps a derived cache at `~/.cache/pi-dash/usage-index-relay.json` (30 days, a few hundred
KB), so a reconnect does not re-read its session files; run `pi-dash-host add HOST` once to update a host's
relay for this.

The context breakdown is published by the bridge, so a remote session shows it only after that host's
pi-dash bridge is updated. Until then its row keeps the measured tokens/window and is marked
`no breakdown`; no composition is invented.

Composition is an estimate, not a provider measurement: pi estimates chars/4 (images at 1,200 tokens),
so parts can drift from the real tokenizer and their sum can exceed or undershoot the measured total.
The residual shows that difference instead of forcing the parts to add up. The view does not attribute
tokens to individual tools, files or messages beyond these categories, and it cannot see what a
provider caches or bills. `BY MODEL` groups by the short model id as the session selected it; a routed
or virtual model is not resolved to a physical model.

What stays local: account quotas and cooldowns. They come from this machine's logins; a login that
exists only on a remote host is not polled, because its credentials stay there. A provider reports
its allowance per account, so an account logged in here shows its balance whichever host used it.

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
  pi's extension event bus. Nested viewer detail is included only in the selected phone session,
  not every overview broadcast. It is bounded to the first 500 entries / 64 KiB (titles 500 characters,
  latest three notes of 200 characters each); an explicit snapshot-limit notice reports omissions.
  Disconnected/exited sessions show last-known state, never implied live progress. No commands,
  model requests or roadmap mutations are sent by either viewer. Update GatPi-Harness as well as
  pi-dash and `/reload` the sessions to publish nested detail; a missing publisher is labelled,
  not displayed as an empty roadmap. The suggested next prompt comes the same way from the GatPi-Harness
  prompt-suggestions extension (`prompt-suggestion:changed`).

Files written: shared Anthropic usage readings and polling deadlines in `~/.pi/agent/pi-dash/quota/`
(private state/lock files per account, no credentials; see [Account quotas](docs/QUOTAS.md)),
the usage index cache at `~/.cache/pi-dash/usage-index.json` (derived, keeps
30 days, about 200 KB; remote hosts keep their own as `usage-index-relay.json`), Hermes advisor feedback at
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
Quota probes never change cooldowns or model selection. An expired OAuth login is renewed through pi's own
locked refresh, not a dashboard implementation, so usage keeps working while no session is using that provider.
Models without a price count in tokens.
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
npm run test:e2e   # real interactive pi in a detached screen with a local scripted model; real pi-dash TUI quota renewal
```

The pi e2e test needs `pi` and `screen` on PATH. It uses an isolated agent directory, does not
call any network or API, and cleans up after itself. `npm run` puts `node_modules/.bin` first on
PATH, so `npm run test:e2e` runs the dev dependency's pi; `node --test 'test/e2e/*.test.ts'` runs
the pi you have installed.

`test/e2e/quota-renewal.test.ts` runs the real TUI in tmux against synthetic credentials: an expired
OAuth login is renewed through pi, shutdown waits for a renewal in flight (`q` and SIGTERM), and a
failing renewal is spaced and sanitized. It is Linux only and needs `tmux` and unprivileged user and
network namespaces (`unshare -r -n`, util-linux 2.23 or newer; some hardened distributions disable
them), and fails with that message when they are missing. It is offline by construction: a temporary
HOME and agent directory, an in-process stub for Anthropic's token and usage endpoints, and no network
at all inside the namespace. Its negative controls run mutants of the working tree and must fail exactly
the checks they target, so a check that cannot fail is itself a failure; a mutation target that no longer
matches the code fails loudly and needs updating. A run takes about 40 s. Interrupting it (Ctrl-C, SIGTERM)
kills the TUIs it started and removes its directories; a run whose checks fail keeps its temporary
directory (path in the output) for inspection, and you delete it afterwards.
