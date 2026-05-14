---
"@enbox/agent": minor
"@enbox/api": minor
"@enbox/auth": patch
"@enbox/browser": patch
---

Add shared agent sessions and high-level Enbox connection helpers.

`@enbox/agent` now exports `AgentSession`, `@enbox/auth` keeps `AuthSession` as a compatible subclass and exposes an `@enbox/auth/auth-manager` subpath, and `@enbox/api` adds `Enbox.from()`, `Enbox.fromSession()`, and async `Enbox.connect()` for common app setup while preserving existing raw/session connect forms. `AuthManager.connect()` now prefers handler routing when handler signals (`protocols`, `connectHandler`) are present alongside local-style defaults. `@enbox/browser` re-exports the new `EnboxSession*` / `EnboxConnect*` types so dapps don't have to reach into `@enbox/api` for explicit annotations.
