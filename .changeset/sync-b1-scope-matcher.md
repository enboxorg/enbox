---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
---

Add a shared permission scope matcher and use it for scoped grant checks. Scoped grant authorization now uses exact protocolPath matching, boundary-aware contextId subtree matching, and distinct Messages grant authorization error codes.
