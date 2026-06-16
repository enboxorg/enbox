---
"@enbox/agent": patch
---

Switch the active sync cycle to durable feed pull/push reconciliation, remove the orphaned SMT reconciler path, and keep dead-letter divergence visible as degraded health instead of treating it as convergence evidence.
