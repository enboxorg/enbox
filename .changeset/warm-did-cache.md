---
"@enbox/agent": patch
"@enbox/dids": patch
---

Retain successful DID resolutions in bounded idle and byte-based caches, use retained documents only when refreshes report a temporary network failure, and protect the vault-owned agent DID from automatic eviction.
