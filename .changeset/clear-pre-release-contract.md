---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/browser': patch
---

Finalize the pre-release application contract: replication freshness is `syncing`, `caught-up`, or `error`, while view `ready` continues to mean locally usable. Remove the unimplemented VC facade until it has a real supported API.
