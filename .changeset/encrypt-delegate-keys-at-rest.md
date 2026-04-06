---
"@enbox/agent": patch
"@enbox/auth": patch
---

fix: encrypt delegate decryption keys at rest using the vault CEK

Delegate decryption keys (DelegateDecryptionKey[] and DelegateContextKey[])
were previously stored as plaintext JSON in localStorage, making them
accessible to any XSS attack on the dapp origin. These keys contain
HD-derived X25519 private key material capable of decrypting all
protocol-encrypted records within the granted scope.

Keys are now encrypted as compact JWE (AES-256-GCM with the vault's
content encryption key) before persisting to storage. On session restore,
they are decrypted after the vault is unlocked. Backward-compatible with
sessions that stored keys as plaintext JSON (detected via JWE format check).

Added IdentityVault.encryptData/decryptData interface methods and
HdIdentityVault implementation.
