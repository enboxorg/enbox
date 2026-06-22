---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/auth": patch
---

Use `Records.Read` as the canonical read-like records permission for read, query, subscribe, and count operations. Connect requests now emit only read/write/delete record permissions, reject obsolete record query/subscribe/count grant scopes, and keep protocol configuration wallet-owned instead of delegating `Protocols.Configure` to apps. Delegate `TypedEnbox` auto-configuration imports the wallet's signed protocol configuration locally instead of requiring a delegated configure grant.
