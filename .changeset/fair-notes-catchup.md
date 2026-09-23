---
"@enbox/agent": patch
---

Bound populated sync catch-up traffic by fetching multi-missing pages inline and avoiding payload reads for retained non-latest writes. Keep sparse inventory comparisons lightweight, retry temporarily unavailable large payloads, and stream them only when needed.
