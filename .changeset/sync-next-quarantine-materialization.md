---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
---

Allow sync-next quarantine retry to settle an exact RecordsWrite already materialized in the local DWN, even when its source is unavailable. Stop retrying terminal JSON-RPC errors returned as HTTP 500 so unsupported local confirmation falls back promptly.
