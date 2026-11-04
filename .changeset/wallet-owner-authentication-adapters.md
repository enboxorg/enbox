---
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/browser": patch
---

Add owner-authentication approval and relay/popup client adapters without creating a DWN delegate session. Combined Connect approval can return a transaction-bound owner proof alongside explicitly requested grants, while verifying the requester origin independently of display metadata.
