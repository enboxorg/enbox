---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
---

Expose opt-in `includeMaterializationConfirmation` for replicated writes. Report `handledCids` for Applied, Duplicate, and Superseded outcomes, and `appliedEntries` only for Applied outcomes.
