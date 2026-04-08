---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

fix: handle duplicate message put as idempotent no-op

MessageStore.put() now treats duplicate writes as no-ops across all
store implementations. This prevents 500 errors when sync or
protocol.send() re-delivers a message the DWN already has (race
between the handler's CID check and the actual insert).

dwn-sdk-js: added shared "idempotent put" test to testMessageStore()
suite — runs against LevelDB and all SQL dialects automatically.

dwn-sql-store: added isDuplicateKeyError() to detect unique constraint
violations from PostgreSQL (23505), MySQL (ER_DUP_ENTRY/1062), SQLite
(SQLITE_CONSTRAINT + UNIQUE), with a message-based fallback for
unknown drivers. 10 unit tests cover all dialect error shapes.
