---
"@enbox/browser": minor
---

feat: ECDH-encrypted postMessage channel for DWeb Connect popup flow

The browser DWeb Connect popup flow now encrypts the authorization response
(containing delegate private keys and decryption material) using an ephemeral
ECDH key exchange between the dapp and wallet popup.

The dapp generates an ephemeral P-256 keypair and sends its public key with
the authorization request. The wallet generates its own ephemeral keypair,
performs ECDH + HKDF to derive a shared AES-256-GCM key, encrypts the
response payload, and sends the ciphertext. The dapp derives the same key
and decrypts.

Falls back to plaintext for wallets that don't support encrypted responses
(backward compatible). Exports encryptPostMessagePayload,
generateEphemeralKeyPair, and EncryptedPostMessagePayload for use by wallet
implementations.
