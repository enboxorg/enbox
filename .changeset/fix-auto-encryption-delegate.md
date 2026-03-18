---
"@enbox/api": patch
---

fix(api): skip auto-encryption for delegates in all TypedEnbox operations

Delegates don't have the wallet owner's private keys, so they can't
derive encryption keys locally. When operating as a delegate, TypedEnbox
now skips `encryption: true` for all operations:

- `configure()` / `_autoConfigureOnce()` — skip encryption key derivation
- `records.create()` — skip client-side encryption
- `records.query()` — skip client-side decryption
- `records.read()` — skip client-side decryption

The wallet already configured the protocol with encryption keys during
connect. Encrypted record operations are handled by the owner's DWN.

Also adds `DwnApi.isDelegate` getter for clean delegate detection.
