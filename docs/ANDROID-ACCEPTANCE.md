# Android/G1 acceptance status

This is a **software release candidate, not a hardware-accepted release**. The
Android app, the intranet gateway and the G1 display path are covered by host,
JVM and connected-UI tests; live G1 hardware, screen-off, recovery and battery
acceptance remain open. Earlier G1 PoC results are protocol evidence, not tests
of this app.

This page records the gate structure and what remains unproven. Per-run operator
ledgers, device identifiers, network addresses and local paths are deliberately
not retained in the repository.

## Automated and connected evidence

| Gate | What it establishes |
|---|---|
| TypeScript strict typecheck (`npm run check`) | Host sources and the bridge type-check against the current pi runtime |
| Host tests (`npm test`) | Gateway authentication, TLS, receipts, revocation, canonical project roots, launch reservations, address handling and configuration checks |
| Real pi/screen end-to-end (`npm run test:e2e`) | Bridge, hub and session behaviour against a real pi process |
| Android app + G1 JVM tests | Pairing, certificate/hostname/fingerprint validation, redirect rejection, address ordering and fallback, card bounds, alert dedupe, protocol packets, ACK/event parsing and measured pagination |
| Android lint and `assembleDebug` / `assembleDebugAndroidTest` | Build and lint gates |
| Connected UI instrumentation | Sessions → Glasses → Pairing → Sessions navigation on a physical device (pairing-safe: the test package is removed afterwards) |

The automated suites do not simulate a radio or establish physical GATT
lifecycle reliability. Connected instrumentation exercises UI reachability, not
host/session control or Bluetooth monitoring.

## What remains untested

- Live G1 connection, both-lens overview, paging, gestures and recovery on this
  app and firmware.
- Screen-off, battery and walking trials.
- Pairing, revocation and re-pair flows against a production gateway on real
  hardware.
- Remote-host sessions, dismiss propagation and confirmation invalidation across
  `/new`, `/reload`, gateway restart and network loss.

## Physical acceptance procedure

Mark a box only with a dated observation for this app, firmware and phone.

### A. Feasibility and ownership

- [ ] The app installs and launches on the target phone without granting more
      permissions than the flow needs.
- [ ] Pairing requires an explicit fingerprint comparison; no insecure recovery
      path exists.
- [ ] Revocation on the host closes existing authenticated streams within five
      seconds and rejects new requests.

### B. Phone security and controls

- [ ] Credentials, drafts and pending receipts are encrypted at rest with a
      Keystore-backed key and excluded from backup and device transfer.
- [ ] Screenshots and recents capture are disabled.
- [ ] Prompt recall steps through earlier prompts newest first; stepping past the
      newest restores the draft.
- [ ] A submitted action is never replayed after a lost acknowledgement; an
      uncertain outcome requires state inspection.
- [ ] Force-stop/reopen preserves the encrypted pending receipt; drafts survive
      locally and are never auto-submitted.
- [ ] Revoking while a stream is open disables controls and closes the stream;
      local erase removes credentials without claiming host revocation.

### C. G1 policy and recovery

- [ ] Overview, pinned session and explicit excerpt render correctly; phone
      Previous/Next changes pages without flooding the display.
- [ ] One new attention transition alerts once; unchanged snapshots and
      reconnects do not replay it.
- [ ] Double-tap dismissal persists through host updates; triple-tap Silent Mode
      suppresses display and returning from it never approves an action.
- [ ] Losing one temple leaves the peer heartbeat active and never reports both
      lenses confirmed without evidence.
- [ ] Case/remove/re-wear, Bluetooth toggling, permission revocation and repeated
      service stop/start leave no stale callback or leaked wake lock.

### D. Screen-off, battery and walking trial

- [ ] Lock the phone for 15 minutes, then at least one hour with monitoring
      explicitly running; observe both-arm heartbeat, Wi-Fi state and whether the
      foreground service survives OEM battery policy.
- [ ] Measure start/end phone and temple battery levels, duration, screen usage,
      update frequency and reconnect counts; do not infer drain from a PoC or
      emulator.
- [ ] Repeat a desk-away/walking session and verify glance legibility, stale
      indicators and safe phone-only confirmation.
- [ ] Stop/force-stop/reboot does not silently resume monitoring, and the
      12-hour cap ends visibly.

## Completion rule

Do not mark hardware acceptance complete until A–D have dated observations for
this app, firmware and phone. Retain concise metadata results and failures; do
not retain secrets, full BLE payloads, user replies or redundant fixture copies.
Follow-on PLAN-5 parity (Git/Hermes and phone restart) remains separately scoped,
not hidden behind unsupported mobile buttons.
