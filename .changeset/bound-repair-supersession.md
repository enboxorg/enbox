---
"@enbox/agent": patch
---

Bound repair churn during repeated subscription flapping by deferring superseding repair signals through the per-link retry backoff without consuming the failure-attempt budget.
