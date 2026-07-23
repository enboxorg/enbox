---
"@enbox/api": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
"@enbox/protocols": patch
---

feat: make `$recordLimit: { max }` one deterministic read-time visibility contract

Query, Read, Count, and subscription snapshots now select at most `max` occupants independently for every direct-parent scope in an ancestor selection. Occupancy is ranked by initial creation time and record ID before authorization, caller filters, sorting, and pagination. Level, browser, SQLite, MySQL, and PostgreSQL share that definition.

Observed typed views widen only limited paths to the structural occupancy scope, so a sibling write or delete can wake and rematerialize an exact-record view when its record is promoted or demoted.

Protocol definitions no longer select a write-time strategy. Valid competing records remain stored, and the unused `purgeOldest` wire value, strategy enum, and write-time strategy guard have been removed.
