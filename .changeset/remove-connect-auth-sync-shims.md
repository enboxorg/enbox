---
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/connect": patch
"@enbox/dwn-sdk-js": patch
---

Persist bounded `applicationId` on connect session grant metadata, snapshot connect inputs uniformly via `structuredClone`, remove local-DWN discovery compat wrappers and storage format version tags, enforce strict `stopSync` timeout validation, and drop `syncNextV1` sublevel naming and legacy quarantine checks.
