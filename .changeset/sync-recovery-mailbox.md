---
"@enbox/agent": patch
---

refactor: serialize link repair and reconciliation through the per-link mailbox

Repair and durable-reconciliation passes now run on the same per-link
mailbox that serializes live-push flushes, with three ownership rules
replacing the old scattered in-flight bookkeeping:

- Shared lanes with trailing runs: concurrent repair or reconcile
  requests coalesce onto one execution, and a request arriving while a
  pass is already executing (a fresh gap with a newer resume token, a
  signal postdating the pass's remote snapshot) runs exactly one
  trailing pass instead of being silently absorbed. The
  `repairInFlight`/`reconcileInFlight` handles are gone.
- Pause is a cancellation fence: pausing stays prompt and mailbox-free
  (it is the fail-safe for revoked authorization), and every repair
  checkpoint, completion step, and late failure handler observes the
  paused status and abandons the link instead of reviving it, reporting
  spurious errors, or rearming timers.
- Push batches die with their runtime: an in-flight push result or
  rejection that lands after a pause or runtime replacement is dropped
  instead of folding transitions, requeueing entries, or recreating the
  runtime the transition just cleared.

Local event ingestion stays synchronous, and events observed while a
repair or reconcile occupies the mailbox queue a flush behind it rather
than stalling until the next event arrives.
