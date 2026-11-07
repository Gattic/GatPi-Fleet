# Account quotas

The overview and Usage views show each signed-in Anthropic/Codex/xAI account's provider-reported
allowance: a bar, percentage **left**, and reset countdown for each returned window. Aliases
such as `anthropic-account-2`, `openai-codex-account-2` and `xai-account-2` have their own readings.
xAI's SuperGrok/X Premium billing probe reports its current credit-usage period and percentage as
a weekly or monthly window. A returned period without a reported percentage stays unknown rather
than inventing an unused balance; its line shows the reported reset time with an explicit
“usage % not reported” label. Window labels use the provider's duration, so a Codex monthly
window is not mislabelled as five hours.
Anthropic's five-hour and weekly balances are both shown when reported. Its unused five-hour
window can have 0% used with a null reset timestamp: the balance remains visible with
“Reset time not reported,” not a made-up countdown. This does not override an exhausted weekly
limit. Codex only shows its returned windows; a missing five-hour window is not added.
Android receives the same sanitized readings through the gateway and advances countdowns from
host time using elapsed time, not the phone's potentially different wall clock. The report and
its monotonic receipt-time anchor are retained together across Activity recreation, so rotation
cannot renew freshness or rewind reset countdowns. Only receiving another report replaces the anchor.

Quotas are for **this machine's** logins. The Usage views' spend figures include the remote hosts'
session files, but a login that exists only on a remote host is not polled: its credentials stay on
that host and are never sent here. A provider reports its allowance per account, so an account that is
logged in here shows its balance whichever host used it.

## Source and boundaries

The narrowly scoped endpoint readers and normalization were adapted from
[Sarrius/pi-multi-account](https://github.com/Sarrius/pi-multi-account), reviewed at
`f5819b36565d74fad2e0af24f952a84f9a053283`. See [license and attribution](THIRD-PARTY-NOTICES.md).
The old extension is not installed or executed. Its routing, its own auth refresh, automatic continuation,
proxies and persistent quota cache are not copied.

`src/manager/collectors/provider-usage.ts` is the credential-bearing integration adapter:

- Anthropic OAuth: `GET https://api.anthropic.com/api/oauth/usage`, with the provider's OAuth beta header.
- Codex OAuth: `GET https://chatgpt.com/backend-api/wham/usage`, with the stored account ID when present.
- xAI OAuth: `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, with the CLI auth
  headers and the user id from the access-token JWT. Only the reported current-period percentage
  and reset time are normalized; a period without a percentage is not treated as unused quota.
  API-key logins have no usage endpoint and are not probed.
- Fixed HTTPS destinations, normal certificate verification, no redirects, a ten-second request
  bound and a 64 KiB response bound. No inference or billable generation request is made.
- Credentials are read locally from Pi's `auth.json`, never sent to Android or exported in reports.
  API keys and other provider families are not sent to these endpoints. Responses expose only
  normalized windows, timestamps and sanitized diagnostics, not email, account IDs or raw bodies.
- Pi refreshes OAuth tokens only when a model request needs one, so a token can sit expired in
  `auth.json` while no session is using that provider. When a polled login's stored expiry is at or
  before the current time, the collector asks **Pi's own runtime** (`ModelRuntime.getAuth`, loaded
  lazily by `oauth-renewal.ts`) to resolve it. Pi performs the refresh under the `auth.json` lock,
  re-checks inside the lock and persists the rotated refresh token, so concurrent Pi sessions, the TUI
  and the gateway refresh at most once and never race. The dashboard has no OAuth client, endpoint
  or token handling of its own, and the usage probe still never sends an expired token.
- A started renewal is never cancelled: the provider may already have rotated the refresh token, and
  abandoning the call before Pi persists it would destroy the login (the `pi-coding-agent` 1.0.0 that the
  dashboard loads discards an aborted refresh outright). Closing the dashboard or gateway therefore waits
  for an in-flight renewal; Pi bounds that wait (30 s for the lock, 15 s for the token request). Killing the
  process with SIGKILL mid-refresh is the same unavoidable risk Pi itself has.
- The dashboard's Pi runtime loads no extensions, so it cannot renew the `anthropic-account-N` and
  `openai-codex-account-N` aliases that the multi-login extension registers. Their usage still shows
  “OAuth refresh required in Pi.” once expired, until a Pi session uses that account and renews it.
- If Pi cannot renew the login (revoked refresh token, or offline), usage shows “OAuth refresh required
  in Pi.” Attempts are spaced five minutes apart **per provider**, so a renewal that stores a
  still-expired token, or a replaced credential, cannot cause a refresh loop against the token endpoint.
  The failure's cause is never displayed. Log in again in Pi to repair it, and the new login is detected
  automatically. Renewal attempts and failures do not reserve provider polls or overwrite an existing
  server cooldown.
  Pi model requests can also refresh OAuth themselves, so successful model inference does not prove
  the previous stored access token was still valid. Conversely, a usage-endpoint 429 is not proof
  of token expiry or model-quota exhaustion: inference and quota reads are separate endpoints.
  Merely reloading the dashboard is not a login repair.

Anthropic polling is shared by dashboard and gateway processes using the same Pi agent directory.
Each account has a private state file and OS lock under `<agent>/pi-dash/quota/` (normally
`~/.pi/agent/pi-dash/quota/`). Linux `flock` from util-linux must be on PATH. An atomic reservation
allows only one controller to fetch; all controllers import the same sanitized reading, with its
original timestamp. The store contains only normalized windows, sanitized errors, polling deadlines,
a reservation ID and a one-way credential fingerprint, never tokens, account IDs or raw responses.
State files are atomically replaced, not accumulated. In-flight leases are separate from completed
poll schedules and server backoff deadlines. If credentials expire after preflight but before
transport, only that request's lease is cancelled, even if its controller closes; a valid refreshed
login is not forced to wait for a probe that never happened. Cancellation cannot release another
owner's lease or erase a server deadline. Unavailable/malformed state blocks that account's probes
with an explicit diagnostic rather than bypassing coordination. OS locks release on process exit;
a crashed request's lease expires normally.

Codex and xAI still poll independently per process, at most once a minute; Anthropic at most once
every ten minutes across controllers. A known window reset permits a fresh probe at that boundary.
Failed probes retain the ordinary interval. A valid `Retry-After` (delay seconds or an HTTP date)
can extend it, never shorten it. Discarding an error response body cannot erase its HTTP status or
retry deadline, even if body cleanup fails. Anthropic deadlines survive controller restarts, token
replacement and logout/login. A late response cannot replace newer readings or shorten a cooldown,
but its valid `Retry-After` can extend the current deadline, even if its owner is superseded or
closed. Current completions and lease cancellation preserve any such extension. These usage
endpoint deadlines are separate from inference-account cooldowns. Closing a manager cancels its
requests. The Android Refresh button fetches the gateway's latest report; it does not bypass limits.

## Honesty of the display

- `fresh`: a successful reading younger than two polling intervals, before its earliest known reset.
  A null reset timestamp neither forces immediate expiry nor disables the polling-age limit.
- `stale`: an older reading, a reached reset, or a failed subsequent fetch. Last values remain
  visibly stale, with their original timestamp. They never acquire freshness from a failed probe.
- `unknown`: no usable reading yet, including invalid OAuth credentials or missing/malformed data.
  A provider period without a reported percentage is unknown, not 0% used; when its reset time is
  reported, the line shows it.
- `unsupported`: no implemented quota endpoint for that provider.

Logout, credential replacement and unreadable auth immediately discard displayed readings. Shared
readings are imported only when their credential fingerprint matches; a replaced account never
receives its predecessor's balance. Provider polling deadlines remain in force. Percentages do not
promise that an inference will succeed; a passed reset never fabricates a replenished quota.

`multi-login-state.json` supplies **separate local account cooldowns**. Quota probes do not change
these timers, switch models, or command pi sessions. The obsolete `provider-failover-state.json`
is never read, even if someone updates its timestamp.

Deploy the updated gateway and Android APK together for the changed Usage response. After a
collector update, restart the TUI and gateway together so they use the same coordination protocol.
Existing pi sessions do not need reloading: collection belongs to pi-dash, not its per-session bridge.
