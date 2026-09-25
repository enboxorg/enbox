---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
"@enbox/dwn-server": patch
---

Allow valid RecordsWrite data to complete an already-admitted ancestry-only initial write, move it to a new durable feed position, and require every MessageStore to expose the ordered replication feed.
