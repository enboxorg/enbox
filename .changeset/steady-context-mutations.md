---
"@enbox/api": patch
---

fix: keep member-context mutations coherent with their authoritative source and local replica

Singleton `set()` now selects the existing record from the context owner's DWN instead of a potentially lagging local replica. Accepted member mutations and idempotent delete outcomes mark the exact followed source pull-pending without letting failed sync bookkeeping reject an already-completed operation. Rejected subscription listeners close their stream, and a scoped delete requires an authorized tombstone before treating a 404 as completed.
