# G1 transport provenance

Ported 2026-10-07 from a private G1 proof-of-concept app. Original SHA-256:

- G1Arm.kt: `844269a0da28096408fc2c5a2e512db078c410f841f66699c2cbe0789a29be6c`
- G1Protocol.kt: `3b9d5bf8e0f03a0eb1c647976d7e5b5633dbdf0735b4441dd58040bd70911222`
- G1Glasses.kt: `506a09a6161b29810197904347ffe610346fcd085d3afba38b2fb0acf6c35181`
- TextPager.kt: `3b1334b6e0d61cd6e9c0ed6fb5626c16142079bbec24d966d7605577294a7e12`

Protocol, arm serialisation, measured pagination and three regression test classes
are reused. Glasses orchestration is adapted to an owned coroutine scope, automatic
G1-only pair discovery with choice on ambiguity, bounded latest-only updates,
dismissal/Silent Mode and independent per-arm heartbeats. No person data, microphone, speech service or
credentials are included. Diagnostics contain only bounded connection metadata,
not text payloads or Bluetooth addresses. See THIRD_PARTY_NOTICES.md for the
upstream BSD notice. New Android/G1 hardware acceptance is still required.
