---
"@enbox/api": patch
"@enbox/browser": patch
---

Keep protocol-role management on the canonical typed Records API: expose exact `$role` paths through `ProtocolRolePaths`, require a recipient when creating a role record, and document create/query/delete as the grant/list/revoke lifecycle. Explicit request annotations now use `TypedCreateRequest<Definition, Codecs, Path>`.
