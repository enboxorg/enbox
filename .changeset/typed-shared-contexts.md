---
'@enbox/api': patch
'@enbox/browser': patch
---

Add `contexts.follow()` and `contexts.list()` with the existing typed records API bound to a durable foreign context, local replica reads, source-authority mutations, exact currentness, and explicit `forget()` or `leave()` lifecycle.

For an already-deleted record with an effective protocol role, `Record.delete()` reuses a cached tombstone only when it was signed under the same role; otherwise it signs a new delete.
