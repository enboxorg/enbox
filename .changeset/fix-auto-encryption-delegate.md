---
"@enbox/api": patch
---

fix(api): skip encryption key derivation for delegates in TypedEnbox configure

When operating as a delegate, `TypedEnbox.configure()` and
`_autoConfigureOnce()` no longer attempt to derive encryption keys
from the connected DID. The delegate doesn't have the owner's private
keys, so encryption key derivation fails with "Key not found".

The wallet already configures the protocol with encryption keys during
the connect flow — the delegate only needs the protocol definition
installed locally without re-deriving keys.
