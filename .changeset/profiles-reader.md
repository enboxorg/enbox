---
"@enbox/protocols": patch
"@enbox/browser": patch
---

feat: add `createProfileReader` — a cached read layer for other users' public profiles

`@enbox/protocols` now ships a profile reader implementing the fetch shape wallets write: one records query for the published profile JSON singleton plus direct anyone-read `RecordsRead`s for the unpublished avatar/hero image singletons. It provides `get()`, refcounted `watch()` with field-level settlement, `getSnapshot()` for `useSyncExternalStore`-style bindings, a retry ladder for retryable statuses (401/403/408/410/425/429/5xx + transport errors), access-driven negative caching, bounded fetch concurrency, idle release, and an injectable clock. Works over a connected records surface (`DwnApi` from `@enbox/api/advanced`) and over `Enbox.anonymous()`. `@enbox/browser` re-exports the reader for batteries-included dapp setups.

Profile JSON is treated as untrusted input: fields are validated against a strict allowlist (string-valued `displayName`/`bio`/`tagline`/`location`/`website`/`pronouns` only) and the requested DID plus separately-fetched image Blobs always win over anything in the JSON. Images load lazily by default (`images: 'eager' | 'lazy' | 'off'`, `loadImages()` on demand), are fetched only after the root profile record is confirmed (orphaned avatar/hero records left by non-pruning deletes are suppressed), are size-validated against the protocol maxima before and after download, and retained Blobs are bounded by a configurable LRU byte budget (default 128 MiB).
