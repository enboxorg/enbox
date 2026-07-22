---
"@enbox/api": patch
"@enbox/browser": patch
---

Add one protocol-derived `QuerySpec` shared by typed record queries and counts, including exact path tag and data-format types. Add authenticated `DwnApi.records.count()`, preserve query/count population parity, and expose the canonical query types from browser builds.

Remove the overlapping `TypedQueryFilter`, `TypedQueryRequest`, and `TypedQueryAllRequest` types and the query-only `parentContextId` alias. Use `QueryFilter`, `QuerySpec`, `QueryAllSpec`, and `filter.contextId` instead; direct-parent scopes receive an internal exact-parent fence, and callers can no longer supply a separate typed `parentId`. Named `TypedReadRequest` and `TypedSubscribeRequest` types now take the protocol definition and exact path so they share the same path-safe filter. Delegated read-like operations now resolve path- and context-scoped grants consistently.
