---
"@enbox/agent": patch
---

Consolidate the sync push/pull dependency-closure fetch helpers (grant resolution, dependency-ref utilities, protocol-config helpers) that were duplicated verbatim in `sync-messages.ts` and `sync-admit-closure.ts` into a shared `sync-fetch-helpers.ts` module. The shared grant resolver also narrows its error handling so unexpected grant-lookup failures (store/network/parse errors) surface instead of being silently swallowed as "no grant".
