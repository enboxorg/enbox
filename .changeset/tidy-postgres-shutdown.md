---
"@enbox/dwn-server": patch
---

Make shutdown idempotent when multiple SQL stores share one cached Postgres pool.
