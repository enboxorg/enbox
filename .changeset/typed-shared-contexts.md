---
'@enbox/api': patch
'@enbox/browser': patch
---

Add `contexts.follow()` and `contexts.list()` with the existing typed records API bound to a durable foreign context, local replica reads, source-authority mutations, exact currentness, and explicit `forget()` or `leave()` lifecycle.

Migration: On an already-deleted record with an effective protocol role, `Record.delete()` now reuses the cached tombstone only when that tombstone was signed under the same role; a mismatch produces a newly signed delete. Retry code must not depend on the prior tombstone CID or on the 409 previously caused by resending it.
