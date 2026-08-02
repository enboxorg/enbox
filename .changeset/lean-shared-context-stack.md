---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/browser': patch
'@enbox/dwn-sdk-js': patch
---

Remove duplicate shared-context and record-mutation paths. Partial updates now use only `TypedEnbox.records.patch(path, recordId, patch)`; `Record.patch()` is removed. Invitations no longer repeat their already-bound protocol, and forgetting a member context removes only the exact accepted source represented by its handle.

Derive followed-context delegation from sync registration, keep failed role-feed admission retryable without durable dead letters, flatten role bootstrap support entries, and share subscription delivery and role-scope traversal internals. Direct agent callers must register the actor before `followSource()` and no longer pass `delegateDid`; use `deleteFollowedSource()` for exact local removal. The redundant `getProtocolRoleActionPaths` helper and root `ProtocolAction` export are removed.
