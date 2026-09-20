# Connect page/worker boundary proof

## Decision

Keep `WalletPostMessageTransport` in the popup provider page. It owns the
opener window, pinned dapp origin, and ephemeral request-decryption key. After
the transport opens and validates the request, the page admits the request to
`ConnectWorkerBoundary.bindPopupRequest()` over the wallet's authenticated
actor channel.
The worker requires the request's signed client-origin hint to equal that authenticated popup origin.

The wallet worker copies the request and returns a short-lived capability. The
capability is HMAC-bound to the worker instance, authenticated gateway
principal, request digest, channel binding, transport, and expiry. Approval
never accepts another request body: it atomically consumes the stored request,
runs `executeConnectApproval()`, seals with `ConnectProvider`, and returns only
the response ciphertext. Denial and cancellation also consume the session.
Pending sessions and the HMAC key are memory-only and are erased at shutdown,
so a restart cannot silently resume consent.
Request JSON and sealed relay envelopes have byte limits before storage or cryptographic processing.

Relay requests are opened in the worker with `ConnectProvider.openRequest()`.
The copied single-use request key is erased after opening, and the response
callback origin must match the relay request origin. The worker API exposes no
generic key export or signing operation.

## Executable evidence

Run:

```sh
bun test packages/lab/tests/connect-worker-boundary.spec.ts \
  packages/lab/tests/connect-popup-boundary.spec.ts \
  packages/lab/tests/connect-relay-boundary.spec.ts
```

The tests exercise real Connect request signing, popup ECDH-ES/XC20P opening
through `WalletPostMessageTransport`, relay direct/XC20P opening through
`ConnectProvider`, pinned popup origin/source filtering, capability tampering,
cross-principal use, expiry, denial, cancellation, one-shot use, capacity, and
worker restart invalidation.

## Remaining P0 evidence

These focused tests do not claim the full A13 browser/agent gate. The popup
test uses Bun's `MessageEvent`/`MessagePort` implementation rather than managed
Chromium, and the relay test stops after opening and binding the real request.
The approval method is wired directly to the real ceremony and sealer, but the
proof does not provide a configured wallet agent, owner identity, DWN, relay,
service worker, encrypted note, or outsider authorization check. Until the
integrated lab fixture supplies those and completes both handshakes, the real
approval/application portion of A13 and the associated A10, A18, and A24
claims remain unsupported.
