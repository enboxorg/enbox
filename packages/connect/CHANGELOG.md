# @enbox/connect

## 0.1.4

### Patch Changes

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11

## 0.1.3

### Patch Changes

- [#1263](https://github.com/enboxorg/enbox/pull/1263) [`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: bidirectional completion signals for the connect handshake. The relay gains an observational completion marker (`POST /connect/complete` + `GET /connect/complete/{state}`, mirroring the claimed marker): clients signal it automatically after successfully opening the wallet's response (`ConnectTransport.confirmComplete`, wired into `ConnectClient` and the browser relay runner, `keepalive` so it survives immediate navigation), and wallets can poll `pollRelayComplete` to flip their pairing screen to a confirmed "connected" state instead of asking the user to dismiss it blind. The popup channel gets the same signal as a payload-less `enbox-connect-ack` postMessage: dapps send it automatically, and wallets can await it via `WalletPostMessageTransport.sendResponseAwaitingAck` to show confirmed success before closing themselves. All signals are best-effort and backward compatible — older relays, wallets, and dapps simply never see them. The relay's connect store now awaits its TTL-cache writes and deletes, closing a race where the PAR response could outrun the request insert (a wallet dereferencing the pointer immediately read a false 404) and hardening the single-use pointer guarantee.

## 0.1.2

### Patch Changes

- [#1253](https://github.com/enboxorg/enbox/pull/1253) [`7e5f7ec`](https://github.com/enboxorg/enbox/commit/7e5f7ec504c8c4f552348c6a091fad389a408a45) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(connect): relay claimed signal — apps can show "phone connected" while waiting for approval

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

## 0.1.1

### Patch Changes

- [#1237](https://github.com/enboxorg/enbox/pull/1237) [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/dwn-sdk-js@0.4.10
  - @enbox/dids@0.1.5
