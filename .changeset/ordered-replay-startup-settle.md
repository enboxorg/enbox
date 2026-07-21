---
"@enbox/agent": patch
---

refactor: order replication startup and settle work per link

Pull and push callbacks now enter independent FIFO replay queues behind one generation-owned readiness barrier. Subscription snapshots or an initial durable reconciliation establish both baselines before callbacks run; resets fence queued work and stale completions. Recovery and settle passes coordinate through the same authoritative replication session while allowing the two replay directions to make progress independently.
