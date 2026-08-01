---
'@enbox/api': patch
'@enbox/browser': patch
---

Add `contexts.follow()` and `contexts.list()` with the existing typed records API bound to a durable foreign context, local replica reads, source-authority mutations, exact currentness, and explicit `forget()` or `leave()` lifecycle.
