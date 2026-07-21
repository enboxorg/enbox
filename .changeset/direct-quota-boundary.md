---
"@enbox/agent": patch
---

Simplify sync quota plumbing by injecting `SyncQuotaManager` directly into durable-feed policy consumers while retaining engine-owned lifecycle fencing for probes.
