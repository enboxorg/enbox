---
"@enbox/agent": patch
---

refactor: make each active link controller the authoritative replication session

Active reconciliation, subscriptions, recovery, and checkpoint commits now
share one controller-owned link object and mailbox. Replication-link storage
serializes read/merge/write mutations across browser contexts so stale link
copies cannot overwrite newer durable state.
