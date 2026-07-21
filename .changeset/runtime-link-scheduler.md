---
"@enbox/agent": patch
---

Move delayed sync repair and reconciliation work into the runtime-owned timer scheduler. Per-link retries now share keyed stale-callback fencing, earliest-wins reconciliation timing, and automatic cancellation on runtime disposal or link removal.
