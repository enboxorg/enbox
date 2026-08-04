---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/dwn-server": patch
"@enbox/dwn-sdk-js": patch
---

Complete the accepted-context lifecycle across every owner endpoint: retain uncertain authority, require and replay durable role tombstones before replacement or removal, send `leave()` to every hosted DWN, fence each local acceptance, and expose the shared catalog through `contexts.list()` and `contexts.observe()`. Context records exclude role paths, typed query continuations stay private behind `next()`, role bootstrap keeps large support metadata on WebSocket while fetching record data over HTTP, replication-support reads reject records without a resolved protocol role, and retryable follow readiness is exposed as `ContextNotReadyError`.

Typed query pagination exposes only `RecordPage.next()`; DWN cursors remain private to the captured query.
