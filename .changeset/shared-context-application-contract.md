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
keys, or feed cursors.

Role-authorized feeds now support delegated callers and bounded encrypted
bootstrap dependencies. The sync engine persists one pull-only exact-context
source at the verified role and endpoint, pauses instead of advancing past
inadmissible data, and exposes explicit context refresh, forget, and leave.
Paused sources re-check their ordered roles at that endpoint; re-following is
the explicit way to select a different endpoint or role group.

Typed records add cursor-free pages, bounded initial change replay, shallow
conflict-aware patches, idempotent deletes, and one observable view lifecycle.
Shared internal implementations replace duplicate canonicalization, protocol
walking, configure lookup, encryption-control matching, connection-status
reads, and permission-record wrappers. Remove the unimplemented VC facade.

Pre-release contract changes: use `RecordPage.next()` instead of supplying raw
pagination cursors or deriving them from a `Record`; use view `ready()` for
local usability and `current` for freshness; replication state is `syncing`,
`caught-up`, or `error`; and a cached delete tombstone is reused only when its
signing role and requested prune behavior still match. Remove the unimplemented
`EnboxAgent.sendDidRequest()` stub; DID operations remain on `agent.did`.
