---
"@enbox/auth": patch
---

fix(auth): close gaps in wildcard delegate grant handling (#897)

- Clear stale sync registration in `importFromPhrase`/`importFromPortable`
  when a delegate has zero active grants (matches behavior in `restoreSession`
  and `importDelegateAndSetupSync`).
- Extract `toSyncIdentityProtocols()` helper in `connect/lifecycle.ts` and use
  it across all sync-registration call sites in `connect/lifecycle.ts`,
  `connect/restore.ts`, `connect/import.ts`, and `auth-manager.ts`, eliminating
  duplicated `'all' | string[] → 'all' | [string, ...string[]]` narrowing
  casts.
- Update stale docstring on `AuthManager._deriveProtocolsFromGrants` to
  reflect the current `'all' | string[]` return type.
- Add test coverage for: mixed wildcard+scoped grants, expired wildcard
  grant, revoked wildcard grant, `Messages.Subscribe`/`Messages.Sync`
  unscoped grant rejection, `importFromPhrase`/`importFromPortable` wildcard
  and zero-grant flows, and `toSyncIdentityProtocols` narrowing.
