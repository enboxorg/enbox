---
"@enbox/dwn-sdk-js": patch
---

fix: converge write/delete arrival order with delete-wins tombstones — a RecordsDelete now displaces a RecordsWrite regardless of timestamp (the convergent counterpart of the write handler's writes-after-delete rejection), and supersession displacement is decided by CID membership rather than timestamp comparison so the retained message survives resumable-task replay
