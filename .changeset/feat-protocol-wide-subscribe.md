---
"@enbox/api": minor
---

feat(api): add protocol-wide subscribe() to TypedEnbox

TypedEnbox now exposes a `subscribe()` method that listens for record
changes across the entire protocol, regardless of protocolPath. Unlike
`records.subscribe(path)` which scopes to a single level, this catches
creates, updates, and deletes at every level of the protocol hierarchy.
