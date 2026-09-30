---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
---

Rename the opt-in replication field from `includeMaterializationProof` to `includeMaterializationConfirmation`. Rename admission and pull-page CID lists to `handledCids` because they also include duplicate and superseded outcomes.
