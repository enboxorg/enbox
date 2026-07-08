---
"@enbox/common": patch
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/browser": patch
"@enbox/dids": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
"@enbox/dwn-sql-store": patch
"@enbox/dwn-server-admin-ui": patch
---

fix: resolve remaining SonarCloud reliability issues (S7773/S7781/S7758/S6853/S8786)

Behavior-preserving reliability hardening across packages:

- Replace global `parseInt`/`isNaN` with `Number.parseInt`/`Number.isNaN` (S7773).
- Replace `String#replace(/…/g)` and `split().join()` with `String#replaceAll` (S7781).
- Prefer `String.fromCodePoint`/`String#codePointAt` in byte-range encoders (S7758).
- Associate admin-UI form labels with their inputs via `for`/`id` (S6853).
- Strip trailing slashes in the local-node `/info` handler with a linear loop
  instead of a backtracking-prone regex (S8786).
