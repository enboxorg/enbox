# Typed Protocols: App Integration -- Complete

WS1 (DWN SDK type tightening), WS2 (Typed Protocol API), and WS3 (Standard Protocols
package) are complete and shipped in `@enbox/protocols` 0.2.x and `@enbox/api`.

WS4 (app integration) is complete, with one remaining enhancement tracked as an issue.

---

## Status

| Task | Status | PR / Issue |
|---|---|---|
| **WS4a.1** Web Wallet: adopt typed protocol API | Done | [web-wallet#28](https://github.com/enboxorg/web-wallet/pull/28) |
| **WS4a.2** Web Wallet: Preferences protocol + settings page | Tracked | [enbox#272](https://github.com/enboxorg/enbox/issues/272) |
| **WS4a.3** Web Wallet: install Social Graph | Done (prior PR) | |
| **WS4b.1** Demo Dapp: adopt typed protocol API | Done | [dapp-demo#10](https://github.com/enboxorg/dapp-demo/pull/10) |
| **WS4b.2** Demo Dapp: install remaining protocols | Done (prior PR) | |
| **WS4b.3** Demo Dapp: update wallet connect permissions | Done (prior PR) | |

---

## Completed Work

### WS4a.1: Web Wallet -- Typed Protocol API

- Rewrote `ProfileHelper` to use `web5.using(ProfileProtocol)` with typed
  `records.query()` and `records.write()` for profile, avatar, and hero operations
- Updated `Web5Helper.configureProtocol()` to use `TypedWeb5.configure()` for
  idempotent protocol installation (removed manual `canonicalize` comparison)
- Migrated wallet CRUD in `IdentitiesContext.tsx` to use
  `web5.using(ConnectProtocol)` with typed `WalletData`

### WS4b.1: Demo Dapp -- Typed Protocol API

- Rewrote `TodoDwnRepository` to use `web5.using(ListsProtocol)` -- all
  `records.write/query/read` calls auto-inject protocol, protocolPath, and schema
- Rewrote `ProfileSettings` to use `web5.using(ProfileProtocol)` for profile and
  avatar CRUD
- Rewrote `protocols.ts` to use `TypedWeb5.configure()` per protocol, removing
  manual `canonicalize()` and query/compare logic
- Surfaced the `Web5` instance in the `useWeb5()` hook instead of accessing the
  private `_dwn` property
- Deleted dead protocol shim files (`src/protocols/tasks.ts`, `src/protocols/profile.ts`)

---

## Remaining: WS4a.2 -- Preferences Protocol (enbox#272)

Install `PreferencesDefinition` in the web-wallet and build a settings page for
theme and locale preferences. See [enbox#272](https://github.com/enboxorg/enbox/issues/272)
for the full task breakdown.
