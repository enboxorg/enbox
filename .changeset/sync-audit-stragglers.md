---
"@enbox/agent": patch
---

fix(agent): resolve remaining sync audit findings with cross-context lifecycle locking

- A link persisted with status `'repairing'` (a repair was in flight when the previous session ended) reloads as `'initializing'`, so the next session re-establishes live replication instead of refusing subscriptions forever; `'paused'` remains a durable decision.
- The deferred-pull/dead-letter lifecycle is serialized per `(tenant)` across every context sharing the storage — browser tabs and workers via the Web Locks API, engine instances in one process via a keyed fallback queue. Admission cleanup, 24h expiry promotion, and unregister's tenant sweep each run their read-decide-write section under the lock, so a live admission can no longer race the expiry path into resurrected retry state or a false `admit-failed` dead letter that would permanently block the CID from re-admission.
- Identity lifecycle mutations (register, update, unregister) take a cross-context per-DID lock — outermost, with the deferred-pull lock nesting inside — so one context's unregister can no longer interleave with another's re-registration and prune its freshly created durable links.
- Unregister deletes tenant-scoped state first and the identity marker last as the commit point: a failed cleanup leaves the registration intact for a simple retry, and a re-registration can never inherit an aged `firstDeferredAt` that would instantly dead-letter its first deferral (new `SyncDeferredPullStore.deleteTenant`, exact-tenant key range).
- An interrupted drain — caller cancellation or a topology change — no longer records a connectivity failure: interruptions say nothing about reachability and must not mark the engine offline or widen the poll backoff.
