---
"@enbox/agent": patch
---

Bound populated sync catch-up traffic by fetching dense missing-message pages inline, reusing durable local messages across concurrent owner/delegate remotes, and avoiding payload reads for retained non-latest writes. Keep sparse inventory comparisons lightweight and stream large current payloads only when needed.
