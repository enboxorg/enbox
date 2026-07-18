---
"@enbox/protocols": patch
"@enbox/browser": patch
---

feat: add `createProfileReader` — a cached read layer for other users' public profiles

`@enbox/protocols` now ships a profile reader implementing the fetch shape wallets write: one records query for the published profile JSON singleton plus direct anyone-read `RecordsRead`s for the unpublished avatar/hero image singletons. It provides `get()`, refcounted `watch()` with field-level settlement, `getSnapshot()` for `useSyncExternalStore`-style bindings, a retry ladder for retryable statuses (401/403/408/410/425/429/5xx + transport errors), access-driven negative caching, bounded fetch concurrency, idle release, and an injectable clock. Works over a connected records surface (`DwnApi` from `@enbox/api/advanced`) and over `Enbox.anonymous()`. `@enbox/browser` re-exports the reader for batteries-included dapp setups.
