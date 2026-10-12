# Account quotas

The overview and Usage views show each signed-in Anthropic/Codex account's provider-reported
allowance: a bar, percentage **left**, and reset countdown for each returned window. Aliases
such as `anthropic-account-2` and `openai-codex-account-2` have their own readings. Window labels
use the provider's duration, so a Codex monthly window is not mislabelled as five hours.
Anthropic's five-hour and weekly balances are both shown when reported. Its unused five-hour
window can have 0% used with a null reset timestamp: the balance remains visible with
“Reset time not reported,” not a made-up countdown. This does not override an exhausted weekly
limit. Codex only shows its returned windows; a missing five-hour window is not added.
Android receives the same sanitized readings through the gateway and advances countdowns from
host time using elapsed time, not the phone's potentially different wall clock. The report and
its monotonic receipt-time anchor are retained together across Activity recreation, so rotation
cannot renew freshness or rewind reset countdowns. Only receiving another report replaces the anchor.

## Source and boundaries

The narrowly scoped endpoint readers and normalization were adapted from
[Sarrius/pi-multi-account](https://github.com/Sarrius/pi-multi-account), reviewed at
`f5819b36565d74fad2e0af24f952a84f9a053283`. See [license and attribution](THIRD-PARTY-NOTICES.md).
The old extension is not installed or executed. Its routing, auth refresh, automatic continuation,
proxies and persistent quota cache are not copied.

`src/manager/collectors/provider-usage.ts` is the credential-bearing integration adapter:

- Anthropic OAuth: `GET https://api.anthropic.com/api/oauth/usage`, with the provider's OAuth beta header.
- Codex OAuth: `GET https://chatgpt.com/backend-api/wham/usage`, with the stored account ID when present.
- Fixed HTTPS destinations, normal certificate verification, no redirects, a ten-second request
  bound and a 64 KiB response bound. No inference or billable generation request is made.
- Credentials are read locally from Pi's `auth.json`, never sent to Android or exported in reports.
  API keys and other provider families are not sent to these endpoints. Responses expose only
  normalized windows, timestamps and sanitized diagnostics, not email, account IDs or raw bodies.
- The collector does **not** refresh or rewrite OAuth credentials. Pi remains their owner. An
  expired/rejected login displays an explicit error; Pi's next login/token refresh is detected
  automatically. Merely reloading the dashboard is not a login repair.

Each dashboard/gateway process collects independently, with one in-flight request per account.
Codex refreshes at most once a minute; Anthropic at most once every ten minutes, matching the
upstream minimum. A known window reset permits a fresh probe at that boundary. Failed probes
wait for the same interval; they are not retried immediately. Closing the manager cancels requests.
The Android Refresh button fetches the gateway's latest report; it does not bypass these limits.

## Honesty of the display

- `fresh`: a successful reading younger than two polling intervals, before its earliest known reset.
  A null reset timestamp neither forces immediate expiry nor disables the polling-age limit.
- `stale`: an older reading, a reached reset, or a failed subsequent fetch. Last values remain
  visibly stale, with their original timestamp. They never acquire freshness from a failed probe.
- `unknown`: no usable reading yet, including invalid OAuth credentials or missing/malformed data.
- `unsupported`: no implemented quota endpoint for that provider.

Logout, credential replacement and unreadable auth immediately discard cached readings. A late
response from a replaced account is discarded. Percentages do not promise that an inference will
succeed; a passed reset never fabricates a replenished quota.

`multi-login-state.json` supplies **separate local account cooldowns**. Quota probes do not change
these timers, switch models, or command pi sessions. The obsolete `provider-failover-state.json`
is never read, even if someone updates its timestamp.

Deploy the updated gateway and Android APK together for the changed Usage response. Existing pi
sessions do not need reloading: collection belongs to pi-dash, not its per-session bridge.
