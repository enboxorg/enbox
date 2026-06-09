---
"@enbox/agent": patch
"@enbox/dwn-sdk-js": patch
---

Remove the speculative records-projection MessagesSync path and dependency hints. Sync now uses only full and protocol-root StateIndex roots.
