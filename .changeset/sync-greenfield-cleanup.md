---
"@enbox/agent": patch
---

refactor: greenfield cleanup of the sync engine — remove backwards-compatibility shims, dead status/config surface, and duplicated helpers; no behavior changes on reachable paths. `startSync` now requires an explicit `mode`, the write-only `receivedToken` checkpoint field is gone, and a checkpoint update can no longer recreate a deleted replication-link record.
