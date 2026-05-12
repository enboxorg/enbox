---
"@enbox/agent": minor
"@enbox/api": minor
"@enbox/auth": patch
---

Add shared agent sessions and high-level Enbox connection helpers.

`@enbox/agent` now exports `AgentSession`, `@enbox/auth` keeps `AuthSession` as a compatible subclass and exposes an `@enbox/auth/auth-manager` subpath, and `@enbox/api` adds `Enbox.from()`, `Enbox.fromSession()`, and async `Enbox.connect()` for common app setup while preserving existing raw/session connect forms.
