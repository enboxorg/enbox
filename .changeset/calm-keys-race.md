---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

Handle duplicate large `RecordsWrite` delivery idempotently in SQL-backed DWNs.

Exact duplicate writes now return `409 Conflict` before reprocessing large data streams, while SQL data and block stores tolerate overlapping duplicate inserts for the same content-addressed data.
