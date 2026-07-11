---
"@enbox/dwn-server": patch
"@enbox/connect": patch
"@enbox/browser": patch
---

feat(connect): relay claimed signal — apps can show "phone connected" while waiting for approval

- **dwn-server**: fetching a pushed connect request now records a
  non-consuming `claimed` marker (same TTL), exposed via
  `GET /connect/status/:requestId` → `{ claimed: boolean }`. The marker is
  keyed by the request ID the app already holds, reveals nothing about the
  request (deleted on fetch), and unknown/expired IDs read as `false`.
- **connect**: `RelayClientTransport` accepts `onClaimed`, fired once from
  the `awaitResponse()` poll loop when the relay reports the claim. Status
  polling only happens when the callback is provided; relays without the
  route degrade silently.
- **browser**: the connect modal's QR stage morphs to "Phone connected —
  finish there" the moment the wallet fetches the request, and stops
  re-minting the QR so the in-flight approval is never orphaned.
