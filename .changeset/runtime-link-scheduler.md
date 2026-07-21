---
"@enbox/agent": patch
---

Move sync repair and reconciliation into runtime-owned link scheduling. Per-link retries now share keyed stale-callback fencing, earliest-wins reconciliation timing, and automatic cancellation on runtime disposal or link removal.
