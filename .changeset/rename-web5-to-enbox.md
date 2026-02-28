---
"@enbox/api": major
---

BREAKING: Rename `Web5` class to `Enbox` and delegate auth to `@enbox/auth`

- Rename `Web5` to `Enbox`, `TypedWeb5` to `TypedEnbox`, and all associated types
- Replace the 267-line `connect()` monolith with a thin synchronous factory that accepts `{ session: AuthSession }` or raw `{ agent, connectedDid, delegateDid? }` parameters
- Remove `processConnectedGrants`, `cleanUpIdentity`, and all auth/registration/vault logic from `@enbox/api` (now lives in `@enbox/auth`)
- Add `@enbox/auth` as a dependency
- Preserve deprecated `Web5` and `TypedWeb5` re-exports for migration
