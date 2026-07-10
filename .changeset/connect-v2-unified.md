---
"@enbox/connect": patch
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/browser": patch
"@enbox/cli": patch
---

feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.
