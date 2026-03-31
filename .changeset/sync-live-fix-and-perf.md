---
"@enbox/agent": patch
---

fix: strip encodedData from live pull events before DWN processing, parallelize sync targets, and immediate-first push debounce

- Fix live WebSocket sync delivery: `extractDataStream()` now deletes the transport-level `encodedData` field after extracting inline data, preventing the DWN schema validator from rejecting every `RecordsWrite` received via subscription.
- Parallelize sync targets: `sync()` reconciles URL groups concurrently; `startLiveSync()` initializes all replication links concurrently. Partial failure keeps the agent online if at least one remote succeeds.
- Immediate-first push debounce: the first write in a quiet window triggers an immediate push (~0ms latency). Burst writes batch via a short 100ms drain timer.
