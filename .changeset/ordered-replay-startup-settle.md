---
"@enbox/agent": patch
---

refactor: order replication startup and settle work per link

Pull and push callbacks now enter independent FIFO replay queues behind one generation-owned readiness barrier. Subscription snapshots or an initial durable reconciliation establish both baselines before callbacks run; resets fence queued work and stale completions. Recovery and settle passes coordinate through the same authoritative replication session while allowing the two replay directions to make progress independently. Administrative sync and settle work skip initializing or repairing links instead of waiting behind their readiness barriers; the in-flight baseline or repair already owns reconciliation for those links.
