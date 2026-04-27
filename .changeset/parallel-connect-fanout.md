---
"@enbox/agent": patch
---

perf(connect): parallelize endpoint fan-out with bounded concurrency in `createPermissionGrants` and the revocation-grant loop in `submitConnectResponse`

Both loops were previously sequential per DWN endpoint, which made the wallet's "Authorizing..." spinner wall-time scale linearly with `(grants × endpoints)`. With multiple permissions and multiple DWN endpoints under network load this dominated the connect flow latency, leaving the user stuck on "Authorizing..." for many seconds before the PIN was shown.

To get the latency win without a thundering-herd risk when either dimension grows large, the agent now uses a small reusable bounded-concurrency primitive — `mapConcurrent` / `mapConcurrentSettled` — exported from `@enbox/agent/utils`. `(grant, endpoint)` tuples are flattened into a single send queue and dispatched through a sliding-window worker pool capped by `CONNECT_FANOUT_CONCURRENCY` (defaults to 8). This protects DWN servers and the browser connection pool from being saturated by a request with many permissions or a tenant with many DWNs, while still hiding endpoint latency.

`createPermissionGrants` retains the "at least one endpoint success per grant" guarantee. `submitConnectResponse`'s revocation-grant fan-out remains best-effort (sync delivers eventually); individual failures are swallowed.
