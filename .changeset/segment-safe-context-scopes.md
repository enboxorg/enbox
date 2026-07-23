---
"@enbox/api": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

fix: make context scopes select an exact context plus only `/`-delimited descendants across Level, browser, and SQL stores

Nested query, count, and subscription selections may now start at an ancestor context, and the typed API forwards that single context selector without deriving a second `parentId` fence. Message protocol-path and context-prefix filters use the same segment-aware store primitive, including Unicode descendants. `SubtreeFilter` is supported only for the hierarchical `contextId` and `protocolPath` indexes; other indexes reject it at the store boundary. SQL migrations give hierarchical columns byte-stable ordering so their exact-and-range predicates remain indexable without allowing case variants to cross a context boundary.

Records filters now reject malformed context paths at message validation, and typed nested-path queries fail synchronously when their required `contextId` scope is omitted. Valid context IDs are at most 600 characters and contain only non-empty alphanumeric segments separated by `/`.

SQL migration 005 changes the `contextId` and `protocolPath` collations and rebuilds the context index. It may briefly hold a schema lock while a populated message table is upgraded. MySQL storage now requires MySQL 8.0 or newer.

Ancestor queries, counts, and subscription snapshots on paths with `$recordLimit` now project occupants independently per direct parent. Occupancy is ranked by creation time and record ID before authorization and caller filters, then response sorting and pagination are applied to the visible occupant population. Level, browser, and SQL stores use the same projection without materializing an unbounded record-ID list.
