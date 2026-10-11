# Android + G1 companion

The PLAN-5 **first-release scope** is implemented: a shared headless manager,
authenticated intranet gateway, native Android session manager, and optional direct
Even Realities G1 display. The desktop TUI remains available independently.

**This is not a hardware-accepted release.** See [acceptance](ANDROID-ACCEPTANCE.md).
No prior G1 proof-of-concept results count as acceptance of this app.

## 1. Host setup

Requirements: Linux, Node >=22.19, GNU screen, OpenSSL, pi >=0.84 and this
repository's bridge. Use the same unprivileged Linux account as your pi sessions.

```sh
npm ci
pi install /absolute/path/to/GatPi-Fleet
ln -s /absolute/path/to/GatPi-Fleet/bin/pi-dash-server ~/.local/bin/pi-dash-server
```

Reload (`/reload`) existing pi sessions after installing/updating the bridge.
Protocol v4 adds process/session/incarnation guards; older bridges are read-only
until reloaded. New live identities are issued on reload, `/new`, and session switch.
No PID-only compatibility command path remains.

Choose a stable LAN IP/DNS name which the phone can reach. Configure the certificate
for **that exact name**, not `localhost`. For example (replace both addresses):

```sh
pi-dash-server init --url https://192.168.1.20:7443 --listen 192.168.1.20
pi-dash-server pair --name my-phone
pi-dash-server serve
```

If the phone also reaches the host at another address, such as its VPN address when
the phone is away from the LAN, repeat `--url` and `--listen` for each one (one port):

```sh
pi-dash-server init --url https://192.168.1.20:7443 --url https://10.8.0.2:7443 \
  --listen 192.168.1.20 --listen 10.8.0.2
```

The certificate is valid for every URL, and the pairing gives the phone all of them in
this order, which is the order of preference: list the LAN address first. Pairing and each
connection start with the first URL and move on to the next when one cannot be reached
(within 3 s for all but the last), so away from the LAN the phone uses the VPN, and back on
it the LAN. Requests go to the URL of the live connection. An address added later needs a
new configuration and re-pairing (below).
A VPN address works only if the VPN delivers traffic between its clients (for an OpenVPN
server, `client-to-client` or forwarding between clients); reaching the VPN server and
its LAN is not enough.

`init` creates `~/.config/pi-dash-server/config.json`, a private TLS key and a
one-year self-signed CA/server certificate. The `listen` addresses default to loopback
if `--listen` is omitted. Each must be one IP address of this host: `0.0.0.0` and `::`
(every interface) are refused, as is the same address twice, however written (`::1` and
`0:0:0:0:0:0:0:1`, or `127.0.0.1` and `::ffff:127.0.0.1`), or the same URL twice, also
written that way (the phone reads `https://[::ffff:127.0.0.1]` as `https://127.0.0.1`). The
gateway listens on the configured addresses only, so the system refuses connections to
any other. One that is absent at start (a VPN not yet connected, a laptop away from its
LAN) is tried again every 2 s and served once it appears, without a restart; the journal
then says `pi-dash gateway listening on ADDRESS`. It keeps being served when the address
goes away and comes back. If another program has the port there, the journal says
`cannot listen on ADDRESS` once and that address stays unused until the gateway
restarts; a port in use at start stops the gateway. The gateway also shows and drives the sessions of the remote
hosts listed in pi-dash's `~/.config/pi-dash/hosts.json` (README, "Remote hosts"),
over its own ssh links. New/Resume offer the same projects as the dashboard's `n`
picker on each host: every directory with pi session history plus those of open
sessions.
Project paths/session references supplied by a client are never executed as
arbitrary filesystem or shell paths.

The listen addresses choose which of this host's addresses answer, not which networks may
connect. Linux accepts a connection to any of its addresses arriving on any interface, so
a device on the LAN that routes `10.8.0.2` to this host reaches the VPN address too, and
every client of the VPN can reach the LAN address the same way. Every connection still
needs the pinned certificate and a device token. Restrict TCP 7443 by source network or
interface with your host firewall to your trusted LAN, VPN and phone. Do not
port-forward this service, expose it on public Wi-Fi, or proxy it to the public
Internet. There is deliberately no plaintext HTTP mode or cloud relay.

### Optional systemd user service

Copy [the example unit](../config/pi-dash-server.service) to
`~/.config/systemd/user/pi-dash-server.service`. Edit `ExecStart` and `PATH` for your
checkout, Node and pi (`command -v node` / `command -v pi` in your normal terminal).
For nvm, use that Node binary's absolute path, not an unrelated `/usr/bin/node`.
The default configuration is `~/.config/pi-dash-server/config.json`. Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now pi-dash-server
systemctl --user status pi-dash-server
```

The service uses the same user's XDG runtime directory and pi agent directory.
With remote hosts it also needs ssh that does not prompt: keys without a passphrase,
or an agent whose `SSH_AUTH_SOCK` is in the service's environment
(`systemctl --user show-environment`). Restart it after `pi-dash-host add`/`remove`.
If you use `PI_CODING_AGENT_DIR`, set it consistently for pi, the TUI and the
service. A service PATH must include `node`, `pi`, `screen`, and the commands pi
needs. Do not copy isolated test-agent/runtime directories or test-bin wrappers
into this environment. Do not run the gateway as root. Starting a user service at
boot while logged out requires an explicit local `loginctl enable-linger`
decision; this setup does not enable it automatically.

The unit deliberately uses `KillMode=process`: screen/pi sessions launched through
it must outlive a gateway stop/restart. The gateway shuts down its own subscriptions
and worker threads; stopping it is not a command to close pi sessions.

#### Everyday start/stop

After installing the unit, run these helpers from the checkout:

```sh
./bin/pi-dash-server-start
./bin/pi-dash-server-stop
systemctl --user status pi-dash-server
journalctl --user -u pi-dash-server -n 50 --no-pager
```

The helpers only call `systemctl --user`; they do not start a test session or a
second unmanaged gateway. To call them from anywhere, link them into your PATH:

```sh
ln -s /absolute/path/to/GatPi-Fleet/bin/pi-dash-server-start ~/.local/bin/pi-dash-server-start
ln -s /absolute/path/to/GatPi-Fleet/bin/pi-dash-server-stop ~/.local/bin/pi-dash-server-stop
```

Stopping does not disable login startup. To disable that too, use
`systemctl --user disable --now pi-dash-server`. Neither operation erases pairing.

#### Keeping an existing phone pairing

Do not run `init` or `pair` again just to install the service. Reuse the existing
configuration, certificate, private key and device authorization file. If promoting
a test configuration to the default directory, stop its old gateway, move the
private directory to `~/.config/pi-dash-server`, and update the absolute `cert`,
`key`, `devices` and `auditDir` paths in `config.json`. Keep the identity files and
paired HTTPS URL unchanged; do not retain a second active configuration.

Preserve private permissions (directory `0700`, configuration/identity files
`0600`).

#### Upgrading from a single-address gateway

Gateways from before several addresses fail to start with `Invalid gateway
configuration` (`listen` and `url` were single values), and the app no longer accepts
their pairing documents (version 1); it asks to re-pair. Create a new configuration
in a new directory with every address, switch to it, and pair again:

```sh
systemctl --user stop pi-dash-server
mv ~/.config/pi-dash-server ~/.config/pi-dash-server.old
pi-dash-server init --url https://192.168.1.20:7443 --url https://10.8.0.2:7443 \
  --listen 192.168.1.20 --listen 10.8.0.2
systemctl --user start pi-dash-server
pi-dash-server pair --name my-phone   # then pair the phone as below
```

The certificate is new, so compare the fingerprint on the phone again. Delete the old
directory once the phone works; its tokens and key are no longer used.

### Pairing and revocation

1. Run `pi-dash-server pair --name PHONE` locally. It prints a new bearer token,
   public certificate, URL, device ID and certificate fingerprint as JSON.
2. Transfer that JSON privately to Android and paste it in **Pairing**.
3. Press **Inspect certificate** and compare SHA-256 with the host's output.
   Check the confirmation only when it matches, then **Trust and pair**.
4. Remove temporary pairing files/clipboard contents after pairing. Never put
   this JSON in Git, logs, screenshots, chat, or an APK.

Each device has a separate 256-bit token. The host stores only token hashes in
an owner-private file; Android encrypts credentials, drafts and pending-receipt
metadata with an Android Keystore key. App data is excluded from cloud backup
and device transfer. Android screenshots/recents capture are disabled. Other
apps or keyboards with access to your clipboard can still see pasted secrets.

```sh
pi-dash-server list
pi-dash-server revoke --id DEVICE_ID
```

Revocation rejects new requests immediately and closes existing streams within
five seconds. An already dispatched command cannot be undone by revocation.
**Disconnect and erase** on Android removes local credentials/drafts, but does
not revoke the token on the host or cancel an in-flight command. For a lost
phone, revoke on the host. To rotate a certificate/token, initialize a new
private configuration directory, switch the service to it, and re-pair devices;
do not disable hostname or certificate checking. There is no insecure recovery.

## 2. Build and install Android

Pinned toolchain: Gradle 8.10.2, AGP 8.7.3, Kotlin 2.0.21, Compose BOM 2024.12.01,
OkHttp 4.12.0. JDK 17 or the Android Studio JBR, Android SDK 35. The sideloaded app
supports API 31+ (Android 12+) and targets API 35. Play Store publication is not
configured; reassess target-SDK requirements before distribution there.

```sh
cd android
export JAVA_HOME=/path/to/android-studio/jbr
export ANDROID_HOME=/path/to/Android/Sdk
./gradlew --no-daemon --max-workers=2 testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or open `android/` in Android Studio. The app ID is `dev.pidash.android`; it does
not overwrite the PoC. No provider API keys, host paths, tokens, microphone,
speech dependencies, or G1 serials are compiled into the APK.

### Private release signing

Create/keep your signing key **outside the checkout**, with a secure backup.
Set `PI_DASH_KEYSTORE` (absolute path), `PI_DASH_STORE_PASSWORD`,
`PI_DASH_KEY_ALIAS`, and `PI_DASH_KEY_PASSWORD` in your local environment, then
run `./gradlew assembleRelease`. Do not echo passwords into shell history or
CI logs. Debug and private release keys differ: Android will not update a debug
install with a differently signed release APK. Uninstalling erases local
pairing/drafts; revoke the old device token and re-pair afterward.

## 3. Session management

The app has five tabs: **Sessions**, **Projects** (new/resume in any known project),
**Usage**, **Glasses** and **Pairing**. Tapping a session opens its detail, grouped into
status, latest exchange, prompt, glasses, side question, recent tools and session
management.

The overview shows status, project, model, context and roadmap progress. Filter
by text or attention. Detail contains bounded latest prompt/reply, recent tools,
resources, usage and side-question answers; it is not a full transcript browser.
The arrows beside the prompt step through the session's earlier prompts, as ↑ and ↓
do in pi's editor: each is shown in place of the draft, and stepping down past the
newest brings the draft back. Editing or sending a recalled prompt makes it the
draft; until then the saved draft stays the one you typed, also if you leave the
session.
Missing resource/context fields display as unknown rather than zero. Cost is
pi's API-equivalent usage, not a provider subscription invoice.

**Usage** is pi-dash's usage view: subscription quota windows with each session's
estimated share, then cost or tokens for today, 7 days or 30 days, per hour/6 hours/day,
by session and by model. Like that view, it counts only the gateway machine's own session
files and logins, not its remote hosts'. It is fetched when you open the tab and with the
refresh icon, both only while the connection is live; it does not update by itself, and
shows when it was made.

Sessions of remote hosts are labelled `name@host`, and Projects groups each host's
projects under its name (the gateway's own machine first; a host that did not answer
is named with the reason).

Phone actions: prompt, explicit steer/follow-up when working, abort, compact,
rename, model/thinking changes, graceful close, side question, new session and
resume in any known project on any host, and dismissing an exited session. Dismissing
removes it from the list on the phone and in pi-dash; `d` in pi-dash removes it from
the phone too. Abort/compact/close/new/resume require confirmation.
Side questions use the session's provider context and are billed separately.
Slash commands, interactive extension dialogs and terminal attachment remain
in desktop pi. Phone text is rendered as text, not executable terminal escapes,
HTML, links or images. Drafts are local and encrypted, never automatically sent.

### Delivery guarantees and unknown outcomes

Commands require a fresh stream, a gateway epoch, an exact live session
incarnation and a matching state revision. Reload/restart/selection changes
invalidate stale actions. A command ID is deduplicated per device for 24 hours
(maximum 1,000 receipts/device); reusing it for different content is rejected.
`received` means queued at the gateway; `accepted` means the bridge acknowledged
execution, **not that an agent turn or compaction completed**. The session state
shows completion. A launch acceptance means GNU screen accepted the launch,
not that pi finished startup; inspect the resulting session.

After a timeout/disconnect/process death, the phone queries the receipt and
refreshes state. It never retries a POST or replays a mutation from a queue.
If an acknowledgement was lost, or the gateway restarted/forgot the receipt,
the outcome is **unknown**. Inspect the actual session locally or on the phone,
then explicitly dismiss the uncertain receipt. Do not blindly repeat the action.
A fresh snapshot replaces the entire overview after reconnect; stale controls
are disabled. Phone-only background connectivity/alerts are not promised.

Both TUI and gateway use exclusive resume reservations in
`$XDG_RUNTIME_DIR/pi-dash/launches/`. A known open session, an unbridged process
in the same project, or a reservation blocks resume. There is no unsafe
"resume anyway" override. Normal pi exit removes its reservation. After an
abnormal screen/host exit, inspect the recorded screen and all pi processes on
the host before removing only a proven-stale reservation. Do not delete the
whole directory to bypass protection. External manual `pi --session` invocations
do not participate in the manager's reservation protocol.

## 4. G1 use

1. Stop/release the Even Realities app or PoC; only one controlling app should
   own the pair. This app does not modify the PoC or depend on its assets.
2. In **Glasses**, tap **Connect** and grant Nearby devices (Bluetooth
   scan/connect) and notification permissions. No channel entry, location or
   microphone permission is required. The phone dashboard works without these
   permissions.
3. Discovery runs for a bounded **20 seconds**, showing its progress. One complete
   G1 L/R pair connects automatically; multiple complete pairs produce **G1 pair
   …** choices. Only matching G1 arms are eligible—G2, incomplete pairs and
   cross-channel combinations are not selected. Conflicting arm identities fail
   visibly instead of guessing. If you cannot identify a listed pair, disconnect
   and make only your pair available before trying again.
4. Use **Overview**, pin a session from detail, or explicitly send a reply excerpt.
   Excerpts are bounded, ASCII-normalized and labelled; they are not full
   transcripts. Pages have five measured lines. **Previous / Next** and the page
   count stay in session detail beside the display actions when that session is
   selected for G1. The same controls are available in **Glasses**; no tab change
   is needed to page an excerpt. Page from the phone, not G1 taps.
5. Double-tap dismissal and Silent Mode stop automatic redisplay. Triple tap
   toggles Silent Mode; single-tap paging is not implemented. Gestures never
   approve prompts, Git operations or other host actions.
6. **Disconnect and release glasses** (also available during discovery/selection),
   or use **Stop** in the persistent notification, to release both arms and the
   wake lock before returning control to the Even app.

Connection progress and errors are separate from host status and page delivery.
The page count is the selected page, not a claim that it has arrived. A small,
fixed-size progress indicator waits for both arms' packet acknowledgments; **✓**
then indicates acknowledgment, not independent visual proof. Normal updates do
not swap wrapping status text or move controls. An unacknowledged update displays
an explicit warning that previous text may remain. Silent Mode and dismissal
remain visible, and cannot be mistaken for confirmation. Connection errors remain
on Glasses after service cleanup and host updates, until another Connect attempt.
Updating from manual-channel onboarding removes that obsolete display preference;
it does not erase the encrypted host pairing or drafts.

Monitoring owns one foreground `connectedDevice` service, a bounded 12-hour
wake lock and independent arm heartbeats/recovery. It is not sticky across
force-stop/reboot and does not request exemption from Android battery policy.
OEM restrictions can still stop it. Screen-off/battery behavior needs real
measurement on your device. The notification contains generic connection status,
not replies. Diagnostics keep 100 in-memory metadata events, never BLE payloads,
addresses or displayed text. There is no analytics or automatic diagnostic upload.

Attention alerts are optional, transition-based and cooled down; reconnect does
not replay the entire attention history. BLE display updates are latest-only,
coalesced, and throttled; logs/tokens/tools are never streamed to the glasses.
The display has a freshness/connection indication and per-arm connection state;
a partial failure is not treated as both arms healthy.

## 5. Operations, storage and verification

- The gateway has no HTTP health endpoint bypassing authentication. An authenticated
  `GET /api/v1/info` checks readiness/version; use `systemctl --user status` locally.
- Logs/audit contain metadata only. Audit rotation is bounded to 10 MB
  across ten segments with a seven-day age limit; usage indexing retains 30 days in a separate server cache.
  Receipts live only in memory. Android keeps at most three encrypted drafts.
- TLS failures: check hostname/IP, certificate expiry, phone clock and fingerprint;
  re-provision when appropriate. Never add `trustAll`/hostname bypasses.
- Missing sessions: same Linux user/agent directory/runtime directory, bridge v5,
  and `/reload`. Interactive pi only: RPC/print-mode subagents do not have bridges.
- Lost Wi-Fi/host restart: stale state is expected; inspect uncertain receipts.
- One-arm recovery: use metadata diagnostics; stop/start monitoring explicitly if
  necessary. Do not erase bonding or change the PoC without understanding ownership.
- Builds/cache/test artifacts are disposable, not authored data. Keep only the
  current successful APK and reports locally; do not commit build directories.
  Emulator fixtures must be stopped and removed after successful smoke tests.

Host gates: `npm run check`, `npm test`, `npm run test:e2e`.
`npm run api:generate` regenerates the request schema and shared snapshot and usage
fixtures; Kotlin tests consume those actual fixtures. See [API](API.md) and
[acceptance procedure](ANDROID-ACCEPTANCE.md) for the remaining gates.

Git/Hermes parity, phone close-and-restart, background-only
phone notifications, SSH/tunnels, speech and camera/QR pairing are not added as
speculative features. PLAN-5 identifies the first group as follow-on parity;
this release uses explicit copy/import pairing and TLS over the LAN or the owner's VPN.
