---
"@enbox/api": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

fix: make context scopes select an exact context plus only `/`-delimited descendants across Level, browser, and SQL stores

Nested query, count, and subscription selections may now start at an ancestor context, and the typed API forwards that single context selector without deriving a second `parentId` fence. Message protocol-path and context-prefix filters use the same segment-aware store primitive. SQL backends use dialect-owned byte comparisons so case variants cannot cross a context boundary.

Ancestor snapshots on paths with `$recordLimit` fail with a 400 response until #1431 provides grouped top-N occupancy by direct parent; returning unprojected stored candidates would violate the record-limit policy.
