---
"@enbox/agent": patch
---

refactor: make live push a coalesced durable-feed wake

Local subscription events now wake one coalesced durable push pass instead of creating in-memory batches or delivery acknowledgements. Every pass resumes from the persisted push checkpoint, and advances it only after a complete feed page is pushed successfully. Retryable failures leave the cursor unchanged so startup, reconnect, or a later wake deterministically replays the owed page. Retryable live-push failures now enter verified reconciliation after five seconds instead of using the removed in-memory 0/250ms/1s/2s retry ladder. Remotely sourced CIDs are marked before local application emits its wake, preventing an immediate echo to the same DWN.
