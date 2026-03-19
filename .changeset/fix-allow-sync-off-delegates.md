---
"@enbox/auth": patch
---

fix(auth): allow sync: 'off' for delegated connect flows

Remove the restriction that forced sync to be enabled for
walletConnect() and handler-based connect(). The sync engine's
SMT tree walk generates hundreds of HTTP requests during initial
reconciliation, easily exceeding DWN server rate limits.

Dapps can now opt out of sync with `sync: 'off'` and rely on
local DWN operations only. The `startSyncIfEnabled()` helper
already handles sync: 'off' as a no-op.
