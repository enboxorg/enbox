---
"@enbox/dwn-sdk-js": patch
---

fix: carry mutable query-visibility facts (flattened `tag.*` and `published`) from the pre-delete latest write onto RecordsDelete tombstone indexes. Without them, tombstones of tagged permission records never match the permission shadow filters and published-record tombstones never match `published: true` queries and subscriptions. Immutable record facts keep coming from the initial write, and pruning an already-deleted record carries the existing tombstone's visibility facts forward.
