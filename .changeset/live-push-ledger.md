---
"@enbox/agent": patch
---

feat: cumulative delivery acknowledgement advances the durable push checkpoint

Local feed deliveries are tagged in feed order and acknowledged as they settle — pushed, echo-suppressed, out of scope, or dead-lettered — and the durable push checkpoint advances through the contiguous acked prefix (AMQP-style cumulative ack). The reconciler's push pass stops re-reading and re-sending feed spans live push already covered. Positions the live path cannot settle hold the checkpoint deliberately until a reconciler pass covers them, after which the covered ledger span is pruned and acked positions above it advance. The pull side's delivery tracking adopts the same track/ack/commit naming.
