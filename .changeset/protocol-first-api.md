---
"@enbox/api": minor
"@enbox/agent": patch
"@enbox/dids": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-clients": patch
---

Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.
