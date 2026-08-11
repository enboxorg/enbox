---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/auth": patch
"@enbox/browser": patch
"@enbox/cli": patch
---

refactor: simplify application lifecycle, observable views, sync status, and package re-exports.

`createConnectionStore()` now requires an application manifest and exposes one
`ConnectionStore` type; protocol-less callers should compose `AuthManager` with
`Enbox.fromSession()`. The store no longer exposes its internally owned auth
manager. Connected snapshots are phase-discriminated and expose identity facts
through `snapshot.session`. Record and context views now implement the shared
`ObservableStore` contract with `getSnapshot()` instead of `getState()`. The
application-level `Enbox.getDwnEndpointStatus()` convenience and the
`ApplicationConnectionStore*` and listener aliases are removed.

`ConnectionStore.connect()` now transparently refreshes a surviving delegated
session when wallet reapproval is required, so applications no longer inspect
the underlying auth manager to choose between connect and refresh. Sync policy
is now configured when the store is created rather than per `connect()` call.

The agent consolidates sync status projection and persistence internals and
removes `clearDeadLetter()`, `clearAllDeadLetters()`, and the redundant
`getRemoteSyncStatus()` wrapper; dead letters heal automatically and remote
rows are available through `getIdentitySyncStatus(did).remotes`. Browser and
CLI entrypoints now re-export their complete environment-safe API and auth
surfaces.
