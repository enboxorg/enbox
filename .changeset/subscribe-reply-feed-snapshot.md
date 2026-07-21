---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
"@enbox/agent": patch
---

feat: subscribe-reply feed snapshot and empty-log anchor cursor

MessagesSubscribe replies now carry the tenant feed's `head` progress token and scope `fingerprint`, observed after the subscription is active. Empty replication logs return a position-zero anchor cursor from `logRead` in both stores, so empty-feed drains checkpoint instead of re-enumerating every pass. The agent captures both subscription snapshots: matching fingerprints atomically establish the pull and push baselines from their respective heads, while missing or mismatched snapshots run one durable reconciliation before queued callbacks are released.
