---
'@enbox/api': patch
'@enbox/agent': patch
---

Add a hosted delegated test context that exercises wallet approval, delegated grants, remote DWN routing, and encrypted records through production Enbox APIs. Delegates can now use their `Protocols.Query` grant when resolving unpublished protocol definitions from a remote DWN; cached definitions are isolated by authorization and invalidated across every authorization scope after accepted configuration changes.
