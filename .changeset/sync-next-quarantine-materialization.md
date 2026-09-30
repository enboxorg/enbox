---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
---

Allow sync-next quarantine retry to settle an exact RecordsWrite already materialized in the local DWN, even when its source is unavailable. Name the opt-in local confirmation consistently across the replication API.
