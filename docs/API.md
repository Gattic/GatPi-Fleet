# Intranet API v1

Source of truth: [`src/server/contract.ts`](../src/server/contract.ts) defines strict
TypeBox request schemas, exported by `npm run api:generate` to
[`api/requests.schema.json`](../api/requests.schema.json). Host tests compare the
checked-in schemas and snapshot and usage fixtures with current projections; Android
JVM tests decode those same fixtures. Responses are projected in `sessions.ts` and
`usage.ts`, not raw bridge objects. Any incompatible wire change must change the API
version and both clients. The local bridge protocol is separately versioned (currently 6).

Every route, including WebSocket upgrade and info, requires
`Authorization: Bearer DEVICE_TOKEN` over TLS. Tokens never appear in URLs.
Browser Origin requests are rejected, no CORS/cookie authentication is provided,
and there are no unauthenticated pairing, shell, file-download or secret routes.
Errors use HTTP status plus `{ "error": "description" }`.

## Queries

| Method/path | Response |
|---|---|
| `GET /api/v1/info` | `version`, `epoch`, host `label`, `capabilities` (`sessions`, `commands`, `launch`, `usage`, `git`, `g1-display`) |
| `GET /api/v1/sessions` | `sessions` overview array (epoch is supplied by info/the stream) |
| `GET /api/v1/sessions/:id` | Selected detail object |
| `GET /api/v1/sessions/:id/git` | Git menu: `epoch`, `revision`, `location`, `head`, nullable `branch`/`upstream`/`pushRemote`, `ahead`/`behind`, `tree`, working-session `warning`, editable `commitPrompt`, and `actions` (`kind`, `label`, nullable `blocked`/`description`) |
| `GET /api/v1/sessions/:id/git/branches` | `branches`: up to 1,000 local branches (`name`, `current`, nullable `upstream`) |
| `GET /api/v1/sessions/:id/git/status` | `text`: control-stripped `git status` output, capped at 32,000 characters |
| `GET /api/v1/projects` | `projects`: opaque `id`, `host` (remote host name, or null for the gateway's machine), `label`, `path`; per host (the gateway's machine, then `hosts.json` order) open projects first, then most recently active. `unreachable`: `host`, `error` for each remote host that did not answer |
| `GET /api/v1/projects/:id/sessions` | `sessions`: opaque `id`, title, lastActive, blocked reason or null |
| `GET /api/v1/usage` | The dashboard's usage view as data (below) |
| `GET /api/v1/commands/:requestId` | Receipt, or unknown if absent |

Sessions include those of the remote hosts in pi-dash's `hosts.json` (labelled `name@host`),
reached through the same relays as the dashboard. Session IDs are opaque SHA-256-derived
references to the host, PID, pi session ID and random bridge incarnation. A PID is never
sufficient to dispatch a command.
References are not credentials. Overview fields include revision, label/project,
status/since, attention transition key, bridge connected flag, model/thinking,
contextPercent, plan, resource/usage aggregates, and per-command disabled reasons.
Session state may also carry an optional `context.breakdown` with estimated parts, a residual and
a bounded history; it is additive, and clients that do not understand it can ignore it.
Unknown values are null, not invented zero measurements. `resources.background` lists live
`bg_run` jobs and subagents with `kind`, `label`, nullable `detail` (the recorded command or
task, control-stripped and capped at 300 characters), `startedAt`, `cpu` and `memory`; an
exited session has an empty list. `cpu` and `memory` cover the job's or subagent's process
subtree, not just its supervisor. `detail` is the recorded intent, not live output. Status `stalled` remains
a CPU/inactivity heuristic that also requires no live tool subprocess. Overview
deliberately omits prompts, replies, asks,
raw errors, transcripts and tools.

Usage is computed like the dashboard's usage view (`u`): spend from the session files of the
gateway machine and of its remote hosts (each host's relay indexes its own), quotas and cooldowns
from the gateway machine's own logins. It is fetched, not streamed. `at` is the host time it was
made, and `indexing` is true until the gateway machine and every connected remote host have
finished a first scan of their session files. `quota` is an array of `{ provider, status, fetchedAt, freshUntil, message, windows }`,
or null when login state cannot be read; an empty array means no logins. `provider` is a display
label, never an email or credential. `status` is `fresh`, `stale`, `unknown`, or `unsupported`.
`fetchedAt` and `freshUntil` are host epoch milliseconds (null before any reading); `message`
is a sanitized diagnostic or null. Each window is `{ label, usedPercent, resetAt }`, with a
0–100 percentage and host epoch reset time, or `resetAt: null` when the provider reports no
reset timestamp (for example, Anthropic's unused five-hour window). A null reset does not discard
the reported balance or mean “reset due”; show “Reset time not reported” without a countdown.
Bars show `100 - usedPercent` **left**.
Clients must stop presenting a fresh reading as current at `freshUntil`, even without another
fetch. Reset expiry does not imply a refill. Stale readings retain their original timestamps;
missing windows stay missing. See [quota collection](QUOTAS.md) for polling and auth boundaries.
Legacy quota snapshots are not used.
`cooldowns` separately lists active local failover timers `{ provider, until }` (host epoch ms),
or is null if account state is unreadable. An empty list means no recorded cooldowns, **not**
available quota. These timers are not provider reset times. Update the app and host together
for this usage-response change.
`hosts` lists the remote hosts in `hosts.json` order as `{ host, status, indexing }`: `status` is
`online`, `connecting` or `offline`, and `indexing` is true while a connected host's first scan runs.
It is empty without remote hosts. A host's usage is incomplete while it is `connecting`, `offline` or
`indexing`: an offline host keeps the usage it reported before, so totals miss what it did since.
A report without `hosts` comes from a gateway that predates this: the app refuses it, and says
"Update the host: its usage report is outdated" rather than showing partial data.
`ranges` has `today` (from the host's local midnight), `7d` and `30d` (the last 168 and 720
whole hours, ending with the current one) in that order, each with `range`, `bucketHours`,
`total` (`cost`, `tokens`, `cacheHit` 0–1), and per measure (`cost`, `tokens`): `series` per
bucket from the range's start to now, the 50 largest `sessions` (`label`, `open`, `value`), the 5 largest `models` (`name`, `value`;
one model through several provider accounts or hosts counts once) and `hosts`: `{ host, value }`
for each machine, the gateway's own first (`host` null) and then each remote host in the order of
the top-level `hosts`, with or without usage. An open session's label is its overview label; any
other is `project › name`, `project › first prompt` or just `project`, with `@host` after the project
for a remote host's session (at most 200 characters).

Selected detail adds nullable `roadmap`: a display-only projection of the publisher's nested
viewer snapshot (`id`, `title`, `lifecycle`, `updatedAt`, workflow `complete`/`total`/`blocked`,
root `outcomes` with separate `complete`/`total`/`blocked`, `totalEntries`, and `entries`). Each
entry has `kind` (`item` or `roadmap`), dotted `path`, `title`, explicit `status`, and latest
`notes`. Paths are structural identifiers and are preserved in full within the publisher's
entry budget, not shortened like preview text. Root outcomes must not be confused with recursive workflow totals. Publisher limits
are 500 entries / 64 KiB, titles 500 characters and three notes of 200 characters per item;
`entries.length < totalEntries` means the snapshot is limited. `null` means no nested detail
was published, not zero work. Overview retains compact plan progress only. Both HTTP detail and
selected-detail stream frames carry the same sanitized projection; no new endpoint or mutation
is introduced. [`api/fixtures/roadmap.json`](../api/fixtures/roadmap.json) is generated through
the real projection and decoded by Android JVM tests.

Selected detail adds a 200-character last-prompt preview, `prompts` (the session's
earlier prompts to recall, oldest first), up to 32,000 characters of latest reply,
suggested prompt, error, model choices, 20 recent tool summaries and 10 bounded
side-question records. Like pi's editor history, `prompts` has each prompt once, where
it was last sent: the session's newest 100 that fit in 100,000 characters, whole, and
only those short enough for a prompt command (32,000 characters). It is not terminal
mirroring or arbitrary history access. Terminal control sequences are stripped. Raw
provider credentials, full process environment and tool output are never projected.

## Stream

`WSS /api/v1/events` immediately sends a full overview. Every frame has `version`,
server `epoch` (random UUID on restart), per-connection strictly increasing `seq`,
and `at` (host wall-clock milliseconds).

- `snapshot`: `sessions` replaces the entire overview.
- `detail`: `id`, `detail` (or null if the selected session ended).
- `receipt`: command `receipt`, only to that device's connections.
- `heartbeat`: at least every five seconds without requiring state changes.

Client subscription: `{ "type": "subscribe", "sessionId": "OPAQUE_ID" }`;
use null to unsubscribe. One selected detail per socket. There is no delta log,
cursor replay or offline command queue. After reconnect a new full snapshot
resynchronizes state; prior per-connection sequence numbers do not carry over.
Old callbacks are generation-guarded on Android. Fifteen seconds without a valid
frame makes Android stale and disables actions. Out-of-order/incompatible frames
fail closed. Revocation closes sockets with code 4001.

Updates coalesce for 250 ms, only changed projections are sent, and slow readers
are disconnected rather than accumulating frames. Maximum body: 128 KiB;
maximum frame/backpressure: 1 MiB. Limits: 240 HTTP/upgrade requests per source IP
per minute, 60 mutation requests/device/minute, 120 subscriptions/device/minute,
and bounded socket/device counts. There is no credential-independent health data.

## Mutations and receipts

`POST /api/v1/sessions/:id/commands`:

```json
{
  "requestId": "a fresh UUID",
  "epoch": "current gateway UUID",
  "revision": "revision from the selected session",
  "command": { "kind": "prompt", "text": "Do this", "deliverAs": "followUp" }
}
```

Typed commands: prompt (32k characters; `steer`/`followUp` required while working),
ask (4k), rename (120), model (`provider`, `id`), thinking (`level`), abort,
shutdown, compact, reload, restart, suggest, dismiss. No unknown properties/commands are accepted. Dismiss is
the only command for an exited session and does not reach a bridge: it removes the
session from the overview and from the dashboard (`d` there does the same for the
gateway; both record dismissals in `$XDG_RUNTIME_DIR/pi-dash/dismissed/`). Prompts beginning
with `/` are rejected: extension dialogs/slash commands require local pi. Prompts
still grant the session its normal tool authority, so a paired phone is privileged.
Compact requires idle state. Ask is refused while another side question is active.
Reload and restart require idle state and no answering side question. Reload refreshes pi's
resources without clearing its conversation. Restart also requires a saved session file:
the session's host gracefully closes pi, waits up to 15 seconds for its process and launch
reservation to exit, then launches `pi --session` with that same file in the same project.
It never launches a replacement after an uncertain shutdown ACK or an exit timeout.
A restart acceptance means screen accepted the replacement launch, not that pi finished startup.
Both actions create a new session incarnation; reselect it from the overview.
`{kind: "suggest"}` requires idle state and requests the existing GatPi-Harness publisher's
manual retry via `prompt-suggestion:request`. The publisher responds synchronously with
acceptance or an explicit error; a missing/older publisher fails the command. Acceptance
starts generation, not an agent turn. The resulting `suggestion` arrives in session detail;
no prompt, draft, or transcript is modified. Desktop Ctrl+R policy and editor gates apply.
The bridge independently checks the exact target immediately before dispatch.

`POST /api/v1/sessions` launches a new session in a listed project, on that
project's host: `{requestId, epoch, projectId}`. Include `sessionRef` from that
project's history to resume. Projects are the same choices as the dashboard's `n`
picker on each host: every directory with pi session history plus the directories
of open sessions. A remote launch whose answer is lost has an unknown outcome. Current
ownership checks and shared exclusive resume reservations apply; arbitrary
paths/launch arguments are not accepted.

`POST /api/v1/sessions/:id/git` runs a confirmed git action on that session's host:
`{requestId, epoch, revision, action}`. Use the **git menu's** revision (not the session
revision). Actions are `{kind: "pull"}`, `{kind: "push"}`, or
`{kind: "switch", branch: "existing-local-branch"}`. No paths, shell commands, force
flags or arbitrary remotes are accepted. The gateway re-reads git and checks the
menu fingerprint (including HEAD's commit ID) and current session before dispatch; changed state requires refresh
and a new confirmation. This is not a filesystem lock against external git users.
Pull is `--ff-only` and requires a branch/upstream. Push requires a branch and uses
its upstream, or offers `push -u REMOTE HEAD` only with exactly one remote. Switch
requires a clean tree and another existing local branch. Ahead/behind is based on
local remote-tracking refs; reading/refreshing the menu does not fetch. Review/commit
only pre-fills the phone's prompt editor with the TUI's prompt (including “Do not push”);
it uses the existing prompt endpoint only when the operator presses Send.

Git mutations share the same receipts, rate limits, audit, epoch checks and no-replay
policy as session commands. An accepted git receipt means the git process completed;
refresh the menu/status to inspect its result. An interrupted git mutation (timeout or
output limit), or a lost remote mutation acknowledgement, is unknown, not a safe-to-retry failure. Git queries remain available while a receipt
is pending so the operator can inspect before dismissing it.

A mutation returns a receipt:
`{requestId, state, at, error?}`. States are `received`, `accepted`, `failed`,
`unknown`. Acceptance is dispatch acknowledgement, not eventual turn completion.
Bridge disconnect/timeout after dispatch is unknown, never a guaranteed failure.
The gateway records at most 1,000 receipts/device for 24 hours in memory. Reusing
an ID with identical content returns the same receipt, not another dispatch;
different content is 409. Server restart creates a new epoch and loses receipts.
There is no claim of durable exactly-once execution across restarts.

Android persists one pending receipt before sending, disables automatic POST
retry/redirect and never resends after transport uncertainty. Reconnect queries
its receipt and state. An old epoch/absent receipt requires explicit human
inspection, not a guessed retry. A rejected stale revision/identity requires a
fresh selection and confirmation.

Auditing records time, opaque device/target ID, action kind and outcome only.
It does not contain prompts, replies, tokens or BLE payloads. See the
[operations guide](ANDROID.md) for credential/storage retention and recovery.
