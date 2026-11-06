---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-clients": patch
"@enbox/agent": patch
"@enbox/api": patch
---

Remove the obsolete CrossModuleRef replication dependency variant in favor of
canonical Parent and Ancestor dependencies. Keep provider-only installation
readiness internal to TypedEnbox and remove its redundant constructor flag.
Remove unused private metadata fields without changing encryption or DID behavior.
