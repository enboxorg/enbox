---
"@enbox/agent": minor
"@enbox/api": minor
"@enbox/auth": patch
"@enbox/browser": patch
---

Add shared agent sessions and high-level Enbox connection helpers.

`@enbox/agent` now exports `AgentSession` plus the `AgentSessionPrimitives` base, so the minimal `{ agent, did, delegateDid? }` session shape lives in one place. `@enbox/auth` keeps `AuthSession` as a compatible subclass and exposes the `@enbox/auth/auth-manager` subpath. `@enbox/api` adds three single-purpose factories: synchronous `Enbox.from(params)` for raw `{ agent, connectedDid }`, synchronous `Enbox.fromSession(session)` for any session-shaped object, and asynchronous `Enbox.connect(options?)` that creates an `AuthManager`, runs `auth.connect()`, and returns `{ auth, enbox, session }`. The three factories have non-overlapping inputs and a single return type each — no polymorphic overload, no `'X' in params` dispatch, no input-shape silent fallthrough. `AuthManager.connect()` continues to prefer handler routing when handler signals (`protocols`, `connectHandler`) are present alongside local-style defaults. `@enbox/browser` re-exports the new `EnboxSession*` / `EnboxConnect*` types so dapps don't have to reach into `@enbox/api` for explicit annotations.
