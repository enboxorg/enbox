---
"@enbox/agent": patch
---

refactor(agent): serialize the live-push regime through a per-link mailbox

`SyncLinkController` gains a mailbox — a FIFO `enqueue` serializing link-scoped work for the controller's lifetime, refusing work after deactivation while letting in-flight operations finish, with rejections surfaced to callers without poisoning the queue. The push regime's read-decide-write bodies (flush and requeue) run through it, so at most one push flush is in flight per link *by construction*: the push-specific `flushing` flag is deleted, `takeBatch` is controller-addressed, and a reconcile requeue serializes behind an in-flight transport batch instead of interleaving with it — removing a source of duplicate re-push work. Local subscription events still append synchronously (ingestion never blocks behind a network push); the start-flush decision reads the generalized `mailboxIdle` signal. First mailbox migration of the Phase-3 per-link-actor series; repair/reconcile and live-pull ordinals follow.
