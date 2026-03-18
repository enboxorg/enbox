---
"@enbox/api": patch
---

fix(api): auto-enable encryption in TypedEnbox when protocol types require it

When a protocol type has `encryptionRequired: true`, TypedEnbox now
automatically passes `encryption: true` to the underlying DWN API for
`create()`, `query()`, `read()`, `configure()`, and `_autoConfigureOnce()`.

This eliminates the need for dapp developers to manually pass
`encryption: true` on every record operation — the protocol definition
is the single source of truth.
