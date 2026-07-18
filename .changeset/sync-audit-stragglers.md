---
"@enbox/agent": patch
---

fix(agent): resolve remaining sync audit findings around restarts, deferrals, and drain connectivity

- A link persisted with status `'repairing'` (a repair was in flight when the previous session ended) reloads as `'initializing'`, so the next session re-establishes live replication instead of refusing subscriptions forever; `'paused'` remains a durable decision.
- Deferred-pull bookkeeping no longer races concurrent live admissions into false dead letters: the merge write re-checks that the deferral still exists (an admission's clear must not be resurrected with a stale `firstDeferredAt`), the 24h expiry re-verifies the row immediately before dead-lettering (an admitted message must never be permanently blocked from future feed admission), and applied-CID cleanup clears the deferral before the dead letter to maximize the abort window.
- `unregisterIdentity` deletes the identity's deferred-pull rows (new `SyncDeferredPullStore.deleteTenant`, exact-tenant key range), so a re-registration cannot inherit a stale `firstDeferredAt` that instantly dead-letters its first deferral.
- An interrupted drain — caller cancellation or a topology change — no longer records a connectivity failure: interruptions say nothing about reachability and must not mark the engine offline or widen the poll backoff.
