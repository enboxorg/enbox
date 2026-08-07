---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/auth': patch
'@enbox/browser': patch
'@enbox/common': patch
'@enbox/dwn-sdk-js': patch
'@enbox/dwn-server': patch
'@enbox/protocol-codegen': patch
---

Add the typed shared-context application contract. Applications declare ordered
role groups once, then use context-bound CRUD, queries, views, path-set change
subscriptions, membership, delivery health, invitations, and durable accepted
context catalogs without handling tenants, grants, role records, encryption
keys, or feed cursors. Invitation discovery uses a bounded newest-first inbox;
unsolicited records can crowd out older invitations. Pagination continuation
and inbox hardening remain tracked in #1552.

Role-authorized feeds now support delegated callers and bounded encrypted
bootstrap dependencies. The sync engine persists one pull-only exact-context
source at the verified role and endpoint, pauses instead of advancing past
inadmissible data, and exposes explicit context refresh, forget, and leave.
Paused sources re-check their ordered roles at that endpoint; re-following is
the explicit way to select a different endpoint or role group.

Typed records add cursor-free pages, bounded initial change replay, shallow
conflict-aware patches, tombstone-aware deletes, and one observable view
lifecycle. `@enbox/browser` now re-exports `DataForPath` alongside the existing
typed application types, removing the need for a second API-package import.

Pre-release view names now match that final lifecycle: use `getState()` and
`RecordViewState` instead of `getSnapshot()` and `RecordViewSnapshot`; inspect
`status` to distinguish loading, ready, and error. `ready` means locally usable,
while `current` reports freshness. Use `RecordPage.next()` instead of supplying
raw pagination cursors or deriving them from a `Record`. Connection replication
state is `syncing`, `caught-up`, or `error`.

Remove the obsolete high-level permission-record wrappers; advanced permission
operations remain available through `Enbox.agent.permissions`. Remove the
manual `Record.send()`, `Record.store()`, `Record.import()`, and `Protocol.send()`
lifecycle. High-level creates and mutations now always persist; their `store`
and `signAsOwner` controls are removed. Exact-message workflows remain available
through the raw agent and `DwnApi`. Remove the unimplemented VC facade and
`EnboxAgent.sendDidRequest()` stub; DID operations remain on `agent.did`.

An existing delete tombstone is reused only when it was signed under the
effective role, already satisfies the requested prune strength, and does not
need an explicitly different timestamp. Context-bound deletion treats a
canonical conflict with an existing tombstone as converged, while a plain
scoped 404 still throws because it does not prove context authority.

`DwnDataStore` is now abstract and owns record enumeration; subclasses provide
protocol metadata, object identity, validation, and optional payload loading.
Remove the internal-purpose `definitionsEqual` and `stripEncryptionBlocks`
exports; protocol installation and manifest checks compare definitions
automatically.

Shared internal implementations replace duplicate canonicalization, protocol
walking, configure lookup, encryption-control matching, connection-status
reads, and validator schema ordering.
