---
"@enbox/agent": patch
---

perf(connect): parallelize endpoint fan-out in `createPermissionGrants` and the revocation-grant loop in `submitConnectResponse`

Both loops were previously sequential per DWN endpoint, which made the wallet's "Authorizing..." spinner wall-time scale linearly with `(grants × endpoints)`. With multiple permissions and multiple DWN endpoints under network load this dominated the connect flow latency, leaving the user stuck on "Authorizing..." for many seconds before the PIN was shown.

`createPermissionGrants` now fans out each grant to every endpoint via `Promise.allSettled`. The "at least one success" guarantee is preserved.

`submitConnectResponse`'s revocation-grant block now creates all per-grant revocation grants concurrently and fires the best-effort fan-out across endpoints concurrently, awaiting them once with `Promise.allSettled`. Individual failures remain swallowed (sync delivers eventually).
