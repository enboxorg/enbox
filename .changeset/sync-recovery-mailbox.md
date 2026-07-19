---
"@enbox/agent": patch
---

refactor: route link repair and durable reconciliation through the per-link mailbox

Repair and reconcile passes now enqueue on the same per-link mailbox that
serializes live-push flushes, so a repair can no longer tear down
subscriptions or reset pull ordering underneath an in-flight push, and a
reconciliation pass can no longer run concurrently with a repair. Shared
mailbox lanes replace the `repairInFlight`/`reconcileInFlight` dedup
handles: concurrent callers coalesce onto one queued-or-running operation
per lane. Local push events observed while a repair or reconcile occupies
the mailbox queue a flush behind it instead of stalling until the next
event, and reconcile-failure requeues issued from inside repair/reconcile
operations fold into the retry policy without re-entering the mailbox. An
externally paused link is now a cancellation fence for an in-flight
repair — the repair abandons the link at every checkpoint instead of
reopening subscriptions and marking a revoked-authorization pause live
again — and a reconcile timer that expires during a repair no longer
produces a duplicate post-repair verification pass. The
fence extends through completion and failure handling: a pause landing
after subscriptions reopen still cancels the repair before it marks the
link live, and repair or reconciliation I/O that rejects after an
external pause stays quiet instead of reporting an error and rearming
retry timers the pause just cancelled.
