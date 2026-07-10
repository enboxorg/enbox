# @enbox/connect

## 0.1.1

### Patch Changes

- [#1237](https://github.com/enboxorg/enbox/pull/1237) [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/dwn-sdk-js@0.4.10
  - @enbox/dids@0.1.5
