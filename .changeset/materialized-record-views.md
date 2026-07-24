---
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

Add explicitly bounded record materialization to typed queries and observed
views. Materialized items pair decoded values with their canonical record
handles and can batch selected direct children declared with
`$recordLimit.max: 1`. Add `records.set()` for those protocol-declared
singletons on the connected tenant. Delegate-backed sets require a Records.Read
grant for the authoritative selection as well as write authorization.

Low-level record filters now accept a non-empty `parentId` selection so one
child query can cover a page of parents. Bounded path-wide nested RecordsSubscribe
requests use the same grouped record-limit projection for dependency wakes;
RecordsQuery and RecordsCount continue to require an explicit nested scope.

`RecordPage` and `RecordView` are now parameterized by the item they contain,
instead of carrying a separate payload type alongside an optional item type.
