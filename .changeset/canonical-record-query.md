---
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/cli": patch
---

Add one protocol-derived `RecordQuery` shared by typed record queries and counts, including exact path tag and data-format types. Add authenticated `DwnApi.records.count()`, preserve query/count population parity, and expose the canonical query types from browser builds.

Remove the overlapping typed query aliases, `queryAll()` drains, Repository facade, and high-level subscription models. Typed records now have one query/count contract, explicit create/update operations, and no client-side upsert or parallel collection abstraction. Callers page explicitly through `query()` with its returned cursor.

Flatten advanced RecordsSubscribe and MessagesSubscribe to their raw DWN contract: a required subscription handler and the unmodified protocol reply. Remove `LiveQuery`, `TypedLiveQuery`, `MessagesLiveQuery`, record hydration, and `includeRecords`; a later observed-view API will be the sole high-level reactive model. Use `filter.contextId` for typed child selection; protocol identity and the exact-parent fence are derived internally. These intentional breaking changes remove the superseded exports from API, browser, and CLI without compatibility aliases.
