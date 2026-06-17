---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
"@enbox/dwn-server": patch
"@enbox/agent": patch
"@enbox/auth": patch
---

Remove legacy StateIndex, MessagesSync, and sparse-Merkle sync surfaces now that replication uses durable message feeds and scoped fingerprints.
