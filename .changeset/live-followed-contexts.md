---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/dwn-server": patch
---

Complete the accepted-context lifecycle across every owner endpoint: retain uncertain authority, require and replay durable role tombstones before replacement or removal, send `leave()` to every hosted DWN, fence each local acceptance incarnation, and expose the shared catalog through `contexts.list()` and `contexts.observe()`. Context records exclude role paths, typed query continuations stay private behind `next()`, and role bootstrap keeps large support metadata on WebSocket while fetching record data over HTTP.
