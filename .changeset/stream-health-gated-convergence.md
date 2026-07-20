---
"@enbox/agent": patch
---

feat: gate the connectivity-driven convergence check on stream health

A wake signal (browser online, tab visible) no longer runs a full verified
`sync()` across every tenant and remote. The convergence check now consults
each replication link's stream health: a link that is live and online with
both subscription halves attached and no repair or reconciliation pending is
provably current — live deliveries commit durable cursors contiguously and a
gap surfaces as repair — so it needs nothing. Stale links get a targeted
reconcile on their own per-link mailbox lane, and only a topology the live
runtime is not fully operating (a target with no active controller) falls
back to the full verified sync. On a healthy wallet a tab focus now costs
zero HTTP RPCs; periodic full verification remains the settle check's job.
