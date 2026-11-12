---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

Collapse DWN SQL store migrations into a single canonical baseline schema (`001-initial-schema`), drop legacy `dataStore` table definitions, and remove pre-substrate store layout checks.
