---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/browser': patch
'@enbox/dwn-sdk-js': patch
---

Keep one shared-context and record-mutation path. Owner and member record surfaces share one typed operations contract, partial updates use `TypedEnbox.records.patch(path, recordId, patch)`, invitations carry only their context-specific fields, and forgetting a member context removes the exact accepted source represented by its handle.

Followed-context replication derives delegation from sync registration, keeps failed role-feed admission retryable without durable dead letters, flattens role bootstrap support entries, and shares subscription delivery and role-scope traversal internals. Direct agent callers register the actor before `followSource()` and use `deleteFollowedSource()` for exact local removal.
