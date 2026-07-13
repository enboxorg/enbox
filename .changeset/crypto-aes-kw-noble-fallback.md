---
"@enbox/crypto": patch
---

fix: fall back to @noble/ciphers' RFC 3394 AES-KW implementation when the runtime's WebCrypto lacks the AES-KW algorithm (Electron/BoringSSL-built Node), instead of failing with "Unrecognized algorithm name". RFC 3394 is deterministic, so fallback output is byte-identical to native WebCrypto in both directions; on every runtime where WebCrypto supports AES-KW, the native path is unchanged. (Changeset for #1270, which merged without one.)
