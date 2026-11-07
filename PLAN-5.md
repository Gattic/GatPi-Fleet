# pi-dash — Plan 5: Android companion and Even Realities G1

Status: first-release implementation delivered, 2026-10-07; **physical acceptance still blocked**.
Implementation/runbook: [docs/ANDROID.md](docs/ANDROID.md). Current evidence and open device gates:
[docs/ANDROID-ACCEPTANCE.md](docs/ANDROID-ACCEPTANCE.md). Follow-on parity remains separately scoped.
The original plan below was based on pi-dash at `5906007e` and the
upstream G1 PoC sources and device-test documentation; source links track the new layout.
This extends the existing manager; it does not move pi execution onto the phone.

## 1. Recommendation

Build a **native Kotlin Android app**, backed by a small **TypeScript intranet gateway** on the Linux machine running pi. Reuse pi-dash's session bridge, collectors, status rules and action implementations. Give the phone a **direct Bluetooth LE connection to the G1**, adapting the working transport from an earlier private G1 proof of concept (the PoC).

The phone is the control surface. The glasses are a concise, read-only heads-up display of session status, attention alerts, roadmap progress and explicitly selected reply excerpts.

Start with one operator, one Linux host and one glasses pair. Use the intranet directly: no cloud relay, public port forwarding, new model provider, or external speech service. Existing pi prompts and side questions still use their configured providers on the host.

## 2. What exists, and what is missing

### pi-dash

| Evidence | What we can reuse / must account for |
|---|---|
| [`src/protocol/index.ts`](src/protocol/index.ts) | Protocol v3 provides snapshots, top-level patches, acknowledgements and commands over Unix sockets. State already contains session identity, status inputs, roadmap, context, usage, recent tools, reply, suggestions, available models and side questions. |
| [`src/bridge/index.ts`](src/bridge/index.ts) | A server per interactive pi process accepts multiple clients. It consumes published roadmap/suggestion events, not harness internals. Commands include prompt, abort, shutdown, rename, compact, model, thinking and ask. |
| [`src/manager/collectors/bridges.ts`](src/manager/collectors/bridges.ts) | `BridgeHub` discovers sockets, reconnects after bridge reload and correlates acknowledgements. Its five-second timeout does **not** prove a command was not executed. |
| [`src/manager/model/store.ts`](src/manager/model/store.ts), [`status.ts`](src/manager/model/status.ts), collectors | Existing status derivation, resource attribution, alerts and history. `stalled?` is a heuristic, not proof that an agent is blocked. Status currently imports activity-lane definitions from UI code; untangle that dependency when extracting the core. |
| [`src/dashboard/main.ts`](src/dashboard/main.ts) | Startup/polling are coupled to a terminal. There is no HTTP server or Android-consumable network API. |
| [`src/dashboard/ui/app.ts`](src/dashboard/ui/app.ts), [`actions/screen.ts`](src/dashboard/actions/screen.ts), [`actions/sessions.ts`](src/manager/actions/sessions.ts) | New/resume, duplicate-resume checks, close/restart orchestration and confirmations are partly UI-owned. They are not all bridge commands. |
| [`README.md`](README.md), [`package.json`](package.json) | Linux, Node >=22.19, GNU screen; canonical checks are `npm run check`, `npm test`, `npm run test:e2e`. |

Important boundaries:

- The bridge exposes **recent information, not a full terminal or transcript API**: last prompt is clipped to 200 characters, latest eligible assistant reply to 32,000, and recent tools to 20. Show these as previews/bounded replies, not complete history.
- Unbridged processes have resource-only visibility. Incompatible bridges require `/reload`; mobile must explain this rather than pretend controls work.
- Shutdown is graceful: the existing UI warns that a working session closes after its current run. Abort is a separate action.
- Interactive extension dialogs and slash commands are not remotely controllable through the current bridge. Identify this limitation explicitly in the app.

### G1 proof of concept

Sources below are in the private PoC checkout, outside this repository; leave that working app unchanged.

| Source | Relevant capability / constraint |
|---|---|
| `README.md`, `TEST-CHECKLIST.md`, `EVENT-DAY.md` | Direct G1 BLE control without Even Hub or MentraOS. The checklist reports glasses-link tests passed on 2026-10-06; event-decoding tests cite the phone used then. These are historical results, not tests performed for this plan. |
| `G1Arm.kt` | One GATT link per temple; callback-serialised setup and writes, notifications, MTU request 251, bonding initiation and request/response matching. |
| `G1Protocol.kt`, `G1Glasses.kt` in the same directory | Match left/right arms by channel, maintain independent eight-second heartbeats, reconnect after missed beats, send acknowledged text to both arms and restore the desired page. Text command `0x4E`, 191-byte payload chunks; exit command `0x18`. |
| `TextPager.kt`, `Card.kt` | Measured text wrapping at 488 px, font size 21, five lines/page; ASCII-normalised text. These are the PoC's working layout rules, not a guarantee of every firmware/font/glyph. |
| `G1Service.kt`, `app/src/main/AndroidManifest.xml` | User-started foreground service and a bounded partial wake lock support screen-off heartbeats. The PoC also declares microphone permissions because it transcribes audio; we do not need those. |
| `G1ProtocolTest.kt`, `G1EventDecodingTest.kt`, `TextPagerTest.kt` in the PoC's unit tests | Reusable packet, pagination and real-frame regressions, including late text acknowledgements during Silent Mode. |
| `THIRD_PARTY_NOTICES.md` | Preserve the BSD attribution for EvenDemoApp and applicable library notices. |

**Do not design around unsupported gestures.** The PoC documents that single taps do not reach the app. Double taps can close the active text; triple taps toggle Silent Mode. Events can arrive repeatedly from both arms, and the reporting arm is not reliably the touched temple. Right long-press records a firmware QuickNote; left long-press behaviour is not established on that pair. None should approve an agent action.

The PoC also documents that the G1 accepts one controlling app. Onboarding must explain how to release the glasses from Even Realities / G1 PoC and hand them back afterwards. Confirm and remember the intended L/R pair; do not silently select the first complete pair if several are nearby.

## 3. Product scope

### First useful increment: read-only phone dashboard

- Pair with the host; display gateway connection and data freshness independently of session health.
- List all discovered sessions, with attention-first filtering and a stable selection.
- Session detail: project/name, model/thinking level, activity, status age, context fill, roadmap progress, latest prompt preview/reply, suggestions, tool summaries, live CPU/RAM/GPU and live usage totals.
- Never hide unbridged/incompatible/exited states or render unavailable metrics as zero.

### First complete release: manage sessions + G1

Add to that dashboard:

- Prompt an idle session; explicitly select **steer** or **follow-up** while working.
- View/edit a suggested prompt before sending it.
- Ask a side question, show its streaming answer, failure and separate usage/cost. Explain that this is a model request, not a free local status query.
- Abort, rename, idle compaction, model/thinking changes and graceful close.
- Start a new session in an approved project; list and resume historical sessions safely.
- Send a selected session or overview to G1; pin a session, page on the phone, hide the display, and optionally receive attention alerts while the phone is locked and glasses mode is active.
- Persist host configuration, display preferences and unsent drafts; do not persist whole session transcripts on the phone by default.

### Follow-on parity, not blockers for the first release

- Historical usage charts and quota views; richer resource charts/background-job detail.
- Close-and-restart, with explicit operation ownership and interrupted-operation reporting.
- Read-only Git status and screen peek, followed by confirmed Git pull/push/branch actions using the existing safeguards. Never an arbitrary shell endpoint.
- Hermes advice through the existing redacted adapter, with human-confirmed actions and feedback semantics preserved.

### Explicit non-goals

A terminal emulator/SSH client, arbitrary terminal-dialog interaction, full conversation browsing, voice commands or glasses microphone capture, cloud push/relay, iOS, multi-host aggregation, multi-user permissions, and G2/Even Hub integration. These need separate requirements, not speculative scaffolding.

## 4. Architecture and ownership

```text
Linux host (same Unix user as pi)
  interactive pi sessions in GNU screen
          | existing private Unix sockets
          v
  shared manager core <----- standalone pi-dash TUI
          ^                   (its own local core instance)
          |
  pi-dash-server (headless core instance, systemd user service)
          |
          | authenticated HTTPS commands/queries + WSS state updates
          | intranet only
          v
  Android: repository/state -> Compose screens + action confirmations
                             -> G1 presenter -> BLE transport -> L + R lenses
```

### Host

Extract a small `src/manager/` layer from the current collectors, model and non-terminal actions. It owns sampling/start/stop, canonical status derivation, session projections and action preconditions. The TUI and gateway call the **same code**, not separate copies of business rules. Terminal rendering, screen attach and keyboard handling remain in `src/dashboard/`.

Keep the TUI independently usable: the mobile service must not have to be running to open a local dashboard. Separate runtime instances are views of authoritative pi/process data, not competing transcript stores. Move extracted files and update all callers in the same change; do not leave old-path aliases.

The gateway runs continuously without a terminal and without the phone. Its exit must not stop pi sessions. Run as the owning user, never root, with the correct `PATH`, `PI_CODING_AGENT_DIR` and `XDG_RUNTIME_DIR`. Document that a user service needs lingering enabled if it must survive logout.

For optional usage workers, use distinct, bounded derived cache files for TUI and gateway; do not let two workers write the same cache/temp path. Reuse the current 30-day retention, and do not copy session JSONL archives.

### Android

Use Kotlin, coroutines/StateFlow, Jetpack Compose, ViewModels and OkHttp. Native Android avoids a JavaScript/native BLE bridge and lets us reuse the PoC's Kotlin transport. A PWA would not eliminate the native/background BLE work.

Proposed minimum: Android 12/API 31, subject to confirming the actual phone. Select and pin the current supported target SDK/toolchain in Phase 0; the PoC's target SDK 35 and Kotlin 2.0.21 are evidence of its build, not a mandate to freeze the new app there.

Start with one app module and one narrowly scoped `g1` Android library module. Keep phone networking/state, UI and glasses presentation separate; do not build a general wearable plugin framework.

Port `G1Protocol`, `G1Arm`, `G1Glasses`, `TextPager` and relevant tests/notices into the library. Replace person-card coupling with a small text-display interface, and give coroutines/GATT an explicit lifecycle owner. Record the source revision or file hashes. No runtime/build dependency on an absolute path to the PoC checkout, and no multi-repository extraction project is needed to ship this app.

**Do not copy** the PoC's reference/person data, name matching, Deepgram code/key, generated asset task, microphone permissions, or page-content logging. It currently logs displayed text and device identifiers: adapt diagnostics to avoid leaking prompts/replies and Bluetooth addresses.

### Cognitive boundary

Continue using the bridge's published `roadmap:changed` and `prompt-suggestion:changed` contracts. No mobile imports from harness internals and no new cognitive library calls. If later work needs additional cognitive capabilities, use the governed integration-boundary adapter rather than scattering internal imports. G1 summaries in v1 are deterministic formatting of existing fields, not new LLM-generated judgments.

## 5. Gateway API and command safety

Do not expose the existing Unix-socket protocol directly to the LAN. It trusts local clients and is not a network authentication/input-validation boundary.

Use a small versioned JSON API; Node HTTPS plus a directly declared/pinned WebSocket server dependency is sufficient. `ws` is already installed transitively, but must become a direct dependency if used. No database or message broker is required for v1.

Proposed routes:

| Route | Purpose |
|---|---|
| `GET /api/v1/info` | Authenticated API version, server epoch, host label and supported capabilities. |
| `GET /api/v1/sessions` | Lightweight session summaries; exclude replies/ask text from overview payloads. |
| `GET /api/v1/sessions/{id}` | Bounded detail for a selected session, including content availability. |
| `GET /api/v1/events` (WebSocket upgrade) | Initial overview snapshot, ordered updates/removals, selected-detail subscription and command receipts. |
| `POST /api/v1/sessions/{id}/commands` | Validated typed bridge actions. |
| `GET /api/v1/projects`, `GET /api/v1/projects/{id}/sessions` | Approved project list and resumable session metadata. |
| `POST /api/v1/sessions` | Start new/resume using server-issued project/session references. |
| `GET /api/v1/commands/{requestId}` | Inspect a known command receipt after a connection interruption. |

Use one small authoritative wire schema with TypeScript/Kotlin contract fixtures; generate DTOs where practical. Do not port `deriveStatus` to Kotlin. The host sends status, attention transitions, capabilities and disabled-action reasons; clients render them. API version mismatches fail clearly rather than silently using old representations.

### Identity and concurrent control

A PID or TUI slot is not a safe remote target. Distinguish the persisted pi session ID from a live process/bridge incarnation, and use opaque API references tied to both. A bridge reload, `/new`, resume, process exit or PID reuse must invalidate old action targets.

Add a bridge-instance token and require expected session/instance identity on commands, checking them **inside the bridge immediately before dispatch**. Bump the Unix protocol and update bridge, hub, TUI callers and tests together; running old sessions need `/reload`, as for existing protocol upgrades. A gateway-only check leaves a race with local session switching.

Recheck operation preconditions at execution: connection/identity, idle requirement, model availability, target project and confirmation context. A stale confirmation must not silently act on another session. Mobile and TUI can both operate; reject concrete conflicts rather than adding a speculative distributed controller/lease system.

### Receipts, uncertainty and reconnect

- Each user submission has a unique request ID. Maintain bounded per-device deduplication/receipt state, including in-flight requests; the same ID with different content is an error. Proposed retention: 24 hours, maximum 1,000 receipts/device, expired IDs not eligible for automatic retry.
- Distinguish **received**, **bridge-accepted**, **failed**, and **outcome unknown**. A bridge ack is not proof a run/compaction/close has completed; completion is observed in state. Do not invent prompt-completion correlation that the bridge does not provide.
- After a lost ack or timeout, refresh state and query the receipt. Never automatically replay a prompt, launch, abort or other side effect. Following a gateway restart, a new epoch makes lost in-memory receipts explicitly unknown; ask the operator to reconcile, not blindly resend. Exactly-once execution across crashes is not promised.
- No offline action queue. Preserve drafts, mark cached data stale and disable commands until authenticated fresh state returns.
- Give each stream an epoch/sequence. Start with a complete snapshot on every reconnect; do not build a durable event replay service. Close/resynchronise slow consumers rather than growing queues indefinitely. Coalesce resource updates and send only selected-session detail.
- Use a network heartbeat separate from pi's event/activity timer. Initial target: stale within 15 seconds of lost liveness; never mistake a quiet idle session for a dead connection. Reads can reconnect with bounded backoff; validation/auth failures require correction, not retries.

### New/resume and destructive actions

- Start only in host-configured project roots. Resolve/canonicalise directories and session references on the server; no client-supplied shell snippets, executable flags or arbitrary session file paths. Use existing argument-based launch helpers.
- Move duplicate-resume checks into the shared action service, recheck immediately before launch, and coordinate manager-launched resumes across TUI/gateway with a per-session launch reservation. Hold it until the resumed process is identified or the launch fails.
- Block mobile resume when an unbridged process in that project makes file ownership uncertain. Explain how to resolve it locally; do not bypass the existing history-corruption warning remotely. An independently launched manual `pi --session` remains an external race unless pi itself gains file locking; document that limit.
- Confirm abort, compaction and close with the session/project and current state visible. Close remains graceful; any abort-then-close must be a separate explicit choice. G1 gestures and notifications never execute these actions.

## 6. Intranet security and deployment

Intranet reachability is not authentication. A prompt can instruct an agent to modify files or run commands with the host user's authority.

1. **HTTPS/WSS only for LAN access.** Bind loopback by default; require explicit LAN address/TLS configuration and restrict the port with the host firewall. No automatic public exposure.
2. **Local provisioning.** A host-side command creates a high-entropy revocable per-device token. Transfer URL/token by a locally displayed QR code or explicit copy; never embed credentials in an APK or repository. A QR code containing credentials is itself sensitive.
3. **Certificate trust.** Use a certificate trusted by Android. If using a private intranet CA, explicitly provision that CA into this app's trust configuration and verify its fingerprint against the host during setup. Retain hostname verification; never use a trust-all TLS client. Certificate/token rotation has a documented re-pair flow.
4. **Credential handling.** Store token hashes on the host in owner-only files; encrypt the phone credential using a Keystore-backed key and exclude it from backups. No tokens in URLs or logs. Revocation closes existing authenticated streams as well as rejecting new requests.
5. **Network validation.** Authenticate before snapshots or WebSocket upgrade; validate schemas, enums, string/body/frame sizes and identifiers; rate-limit authentication and commands. No browser cookie auth or permissive CORS. Deny unsolicited browser origins on the WebSocket endpoint.
6. **Minimal exposure.** Host model/provider credentials stay on the host. Phone lock-screen notifications and automatic G1 alerts omit prompts/replies/tool arguments by default. Explicitly showing a reply on glasses is an operator action, not a background default.
7. **Bounded diagnostics.** Audit timestamp, device, target, action kind and outcome, not prompt/reply bodies. Proposed caps: host logs 10 MB total/7 days; phone diagnostics 5 MB total/7 days. Redact exported logs and exclude secrets from crash reports/backups. Retain only the latest three successful local APK builds; preserve signed releases and deliberate failure evidence separately.

## 7. Phone UX

Four primary surfaces:

1. **Sessions:** attention count, filter/search, status rows, small roadmap/context indicators, and separate host-connection freshness. Attention-first is a view, not a redefinition of stable session identity.
2. **Session:** readable latest reply, prompt preview, roadmap, recent tools and metrics; prominent composer and ask action; less-common/destructive controls in a menu. Distinguish "queued/accepted" from "finished".
3. **New / resume:** approved project picker, history, already-open indicators and clear blocked-resume reasons.
4. **Glasses / connection settings:** server pairing, connect/disconnect G1, left/right readiness, Silent Mode, active card/page, pin, previous/next, hide, attention-alert opt-in and diagnostics.

Show unavailable capabilities with reasons: missing bridge, wrong protocol, offline gateway, no roadmap, unsupported action or incomplete glasses link. "Needs attention" does not imply a remotely answerable dialog; tell the user when desktop pi is required.

No large live reply payloads on every list update. Sanitize terminal control sequences before phone/G1 rendering; do not enable arbitrary HTML or automatically load remote images embedded in assistant Markdown.

## 8. G1 display and lifecycle

### Initial cards

Use the PoC's five-line text layout, not screenshots of the phone UI. Examples are logical layouts; width-aware truncation/wrapping must keep the actual result within five lines.

Overview:

```text
PI DASH | 6 sessions
2 need you | 1 error
3 working
Oldest: api-fix 4m
Host online
```

Pinned session:

```text
API-FIX | WORKING
Tool: test_runner
Plan: 3/7 complete
CTX 54% | CPU 120%
Updated 14:32
```

An attention card contains session label, actual status/reason and waiting time. An explicitly selected reply excerpt can use up to three manually paged screens; label it an excerpt and leave the full bounded reply on the phone. Preserve full Unicode on the phone, but use the PoC's explicit ASCII substitutions/unsupported-glyph handling on G1 until other glyphs are device-tested.

### Display policy

- Default: phone selects an overview or pinned session. No automatic carousel or transcript scrolling.
- Optional attention alerts: deduplicate by session incarnation and attention transition, not incoming patch. Coalesce bursts, apply a cooldown, and provide a phone mute. Do not make every elapsed-second/resource sample repaint the lenses.
- Start with at most one content refresh every two seconds; send only changed cards, rounding timers/metrics. Keep one in-flight display operation plus the latest desired card, not an unbounded queue. Heartbeats must remain timely even during text traffic.
- Mark network-stale data visibly (`OFFLINE`/last update). Do not leave an old "all clear" represented as live. Gateway freshness and left/right BLE readiness are independent states.
- Treat `CLOSE_ACTIVE` idempotently. Ordinary updates must not immediately reopen a dismissed card. Silent Mode suppresses automatic sends; on its end/reconnect, send only the current desired, non-dismissed card, not old alert backlog. The PoC cannot know a Silent Mode toggle made while disconnected; keep that uncertainty explicit.
- Show "on lenses" only after both arms acknowledge. Preserve late-ack matching and test sequence wrap/reconnect; a BLE ack is delivery evidence, not proof the wearer read it.
- Phone controls perform paging. Do not infer a usable single-tap/long-press API from protocol constants alone. Head-up/down events are not required for v1.

### Android background behaviour

Glasses mode is explicitly started from the foreground and owns a `connectedDevice` foreground service, visible ongoing notification/Stop action, BLE session and bounded wake lock. Request Bluetooth scan/connect, notification and relevant foreground-service permissions when needed. **No microphone permission.** BLE is optional for using the phone dashboard.

Validate current Android foreground-service/local-network permission rules for the chosen target SDK in Phase 0. Do not assume the PoC manifest is sufficient on a newer Android release. The service owns the gateway subscription during glasses mode; the screen must not create a second independent live connection.

Measure battery cost before choosing wake-lock policy. The PoC has a 12-hour cap: any retained limit must end/renew the visible monitoring session coherently rather than silently losing heartbeats when it expires. On Stop, permission revocation, logout or service teardown, close sockets/GATT, cancel work and release the wake lock. After force-stop/reboot, require explicit restart for v1 and explain that monitoring is off.

Without glasses mode, v1 keeps the phone dashboard live while foregrounded and refreshes on return. **Do not promise continuous phone-only locked-screen alerts** from a regular WebSocket or WorkManager. If that becomes a requirement, design and validate a separately permitted background-delivery mechanism; do not misuse the connected-device service type or introduce cloud push silently.

## 9. Proposed file boundaries

```text
src/manager/                 extracted reusable runtime/model/collectors/actions
src/server/                  network API, auth, DTO projection, receipts
src/protocol/                private bridge protocol; identity guard upgrade
src/dashboard/               terminal UI + terminal-specific integration
bin/pi-dash-server           headless entry point
config/pi-dash-server.service
android/app/                 Compose UI, network repository, foreground service
android/g1/                  ported G1 transport/paging, notices and tests
api/                         wire contract and cross-language example fixtures
test/server*.test.ts          gateway/socket/action tests, discovered by npm test
```

These are implementation targets, not files already present. Add one Android build root inside this repository; no separate backend repository, multiplatform framework or generic transport abstraction.

## 10. Delivery phases and exit gates

Estimates are engineering days for one developer familiar with TypeScript/Kotlin, assuming access to the actual phone and glasses. They are planning ranges, not commitments. Do not begin a broad refactor before the highest-risk device slice works.

| Phase | Scope | Exit gate | Estimate |
|---|---|---|---|
| **0 — Vertical feasibility slice** | Confirm phone/Android/G1 firmware and host; build an isolated Android shell using the ported BLE/text code; send a representative synthetic session card, then a read-only local session snapshot. Prove TLS trust and screen-off network + BLE behaviour. Record permissions and foreground-service policy. | Both lenses render the card; phone lock/unlock, Wi-Fi interruption and glasses case/reconnect tested. Record gaps; no claim of general firmware support. | 1–2 d |
| **1 — Shared manager core** | Extract only the runtime/model/actions needed by both clients; remove UI dependencies from status logic; preserve standalone TUI and private socket permissions. | Existing type/unit/render/e2e gates pass; simultaneous local clients observe the same sessions; closing either does not stop pi. | 2–3 d |
| **2 — Secure read-only gateway** | systemd user entry point, HTTPS/WSS, provisioning/revocation, DTO/schema fixtures, snapshot/update/resync, freshness and bounded queues. | Auth/TLS-negative tests pass; no data before auth; revoke active client; bridge reload/PID reuse and network reconnect produce correct state. | 3–5 d |
| **3 — Phone dashboard** | Pairing, session list/detail, roadmap, recent content, live metrics, connection/error states and draft retention. | At least three real sessions match the TUI; healthy-LAN status updates reach phone within 2 s at p95; offline data is clearly stale and controls disabled. | 3–4 d |
| **4 — Safe mobile control** | Bridge target guards/protocol upgrade, shared action preconditions, receipts, prompts/asks/abort/compact/model/rename/close, approved new/resume. | Complete prompt → response → follow-up plus new → close → resume from phone. Test lost ack, duplicate tap, server restart, concurrent TUI change, stale confirmation and duplicate resume without silent replay/wrong-target actions. | 3–5 d |
| **5 — G1 daily-driver mode** | Overview/pinned/excerpt cards, phone paging, deduplicated opt-in alerts, latest-only updates, Silent Mode/dismissal, foreground lifecycle and onboarding/handback. | Healthy-link important changes reach both lenses within 3 s at p95; replay the PoC's device checklist against this app, then a one-hour unplugged locked-phone session. No dismissal resurrection or heartbeat starvation. | 3–5 d |
| **6 — Hardening and delivery** | Security review, denial/revocation/process-death cases, battery baseline, signed APK/update path, bounded logs, install/runbook and a working-day field trial. | Gateway works without TUI; app works without glasses; restart/reconnect causes no unintended command. Record battery drain and agree a practical operating limit before declaring daily-driver readiness. | 2–4 d |

Total: approximately **17–28 engineering days (roughly 4–6 working weeks)**, plus elapsed field-test time. Re-estimate after Phase 0. Read-only mobile usefulness arrives after Phase 3; the initial G1 risk is tested in Phase 0 rather than discovered at the end. Follow-on parity is separately prioritised after the first complete release.

## 11. Verification plan

### Host regression and integration

- Existing repository gates: `npm run check`, `npm test`, `npm run test:e2e` (isolated interactive pi + GNU screen, no model API required).
- Focus existing `test/model.test.ts`, `test/protocol.test.ts`, `test/bridges.test.ts`, `test/app.test.ts`, `test/ask.test.ts` and `test/e2e/bridge.test.ts` when extracting or changing their boundaries.
- New gateway tests should use real temporary Unix sockets and the existing scripted provider where appropriate. Cover snapshot/update ordering, disconnect/reload, incompatible versions, identity changes, auth expiry/revocation, invalid/oversized input, slow clients and command uncertainty.
- Cross-client tests: TUI and phone command races, local `/new`, process/PID replacement, session file already open, unknown unbridged holder, launch reservation cleanup and gateway restart. No claims of exactly-once delivery beyond tested semantics.

### Android and wire contract

- Use the PoC's existing Gradle test/lint/build pattern as the starting point: `testDebugUnitTest lintDebug assembleDebug`. Add repository scripts/CI for the new `android/` root once it exists; add `connectedDebugAndroidTest` for device UI/lifecycle checks.
- Port protocol/event/pager regressions; add view-model/reducer tests and mock-server tests for TLS/auth, schema decoding, stale state, reconnect, request IDs and no offline replay.
- Test sanitisation, long names/URLs, unsupported glyphs, five-line layout, capped excerpts, burst coalescing, duplicate close events, Silent Mode, late ACKs and shutdown cancellation.
- Share representative wire fixtures between TypeScript and Kotlin so DTO drift is detected, rather than maintaining two incompatible interpretations of session state.

### Real hardware — required, not replaceable by an emulator

Record phone/Android, G1 firmware, build IDs and starting battery. Test both arms, one-arm loss, delayed ACKs, Bluetooth off/on, out of range, case close/open, Silent Mode, double-tap dismissal, competing Even app, Wi-Fi loss/return, LAN without internet, phone lock/pocket, battery saver/Doze, denied/revoked permissions and service termination. Measure update latency, reconnect time and phone/glasses battery drain.

The PoC's 10-minute screen-off checklist is a regression baseline, not sufficient evidence for a day-long manager. Keep bounded redacted logs and deliberate failure evidence; do not archive unlimited APKs/device dumps.

## 12. Decisions to confirm before implementation

Defaults above let work start without a large product-design exercise. Confirm only:

1. Is the phone the PoC was tested on still the target phone, and what Android/G1 firmware is currently installed?
2. Which Linux host/address should serve the app, and is an intranet TLS CA already available? Otherwise provision app-specific trust locally.
3. Which project roots may mobile launch/resume? Default to explicitly approved roots, not all host directories.
4. Are alerts needed while the phone is locked **without** G1 connected? This is outside the proposed v1 background guarantee.
5. Are project names/statuses acceptable in automatic glasses alerts? Default to no prompt/reply content without an explicit display action.

## 13. Evidence and claim limits

This plan was grounded in the current local pi-dash and G1 PoC code/docs. No Bluetooth connection, Android build, phone install, model call or network gateway was exercised while writing it. Historical PoC results establish a credible reuse path, not that the proposed app already works. New files, APIs, timing targets, security policies and estimates above are proposals and acceptance gates, not implemented capabilities.
