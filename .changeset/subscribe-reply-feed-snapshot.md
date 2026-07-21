---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
"@enbox/agent": patch
---

feat: subscribe-reply feed snapshot and empty-log anchor cursor

MessagesSubscribe replies now carry the tenant feed's `head` progress token and scope `fingerprint`, observed after the subscription is active. Empty replication logs return a position-zero anchor cursor from `logRead` (both stores), so empty-feed drains checkpoint instead of re-enumerating every pass. The agent adopts the reply head as its pull checkpoint on cursor-less subscription opens when the reply fingerprint matches the local feed — a fresh or reset link against an already-identical remote converges with zero feed enumeration.
