---
"@enbox/api": patch
"@enbox/browser": patch
---

refactor: use generic `RecordsWriteResponse<T>`, `RecordsQueryResponse<T>`, and
`RecordsReadResponse<T>` across raw and protocol-scoped APIs, replacing the
duplicate `TypedCreateResponse`, `TypedQueryResponse`, and `TypedReadResponse`
types. Write and read responses now always contain a `record` property whose
value is `undefined` when the operation did not return a record. `RecordOptions`
no longer accepts the unused `remoteOrigin`; its `dataAccess` context remains
the single source of truth for lazy-read routing.
