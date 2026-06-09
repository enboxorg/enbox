---
"@enbox/agent": minor
"@enbox/dwn-sdk-js": minor
---

Remove the speculative records-projection MessagesSync path and dependency hints. Sync now uses only full and protocol-root StateIndex roots.

Removed the `recordsProjection` `SyncScope` variant, records-projection scope helpers, `RecordsProjection`, and the MessagesSync dependency-hint wire types/exports.
