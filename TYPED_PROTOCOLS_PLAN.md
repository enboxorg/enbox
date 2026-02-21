# Typed Protocols: Remaining Work -- App Integration

WS1 (DWN SDK type tightening), WS2 (Typed Protocol API), and WS3 (Standard Protocols
package) are complete and shipped in `@enbox/protocols` 0.2.x and `@enbox/api`.

What remains is WS4: integrating the typed protocol API (`web5.using()` / `TypedWeb5`)
and the remaining `@enbox/protocols` definitions into the example apps.

---

## Current State

Both apps already import `@enbox/protocols` for protocol **definitions** (URIs, schemas)
but neither uses the **typed API** (`defineProtocol()` / `web5.using()`).

| Capability | web-wallet | dapp-demo |
|---|---|---|
| `@enbox/protocols` dependency | Yes | Yes |
| Profile + Connect installed | Yes | Yes |
| Lists installed | No | Yes |
| Social Graph installed | No | No |
| Preferences installed | No | No |
| Status installed | No | No |
| Uses `TypedWeb5` / `web5.using()` | No | No |

---

## WS4a: Web Wallet (`examples/web-wallet/`)

### 1. Adopt typed protocol API

Replace raw `Web5Helper` CRUD calls with `web5.using(ProfileProtocol)`:

- **`src/lib/ProfileProtocol.ts`** -- Rewrite `ProfileHelper` to use `TypedWeb5` methods
  (`write()`, `query()`, `read()`) instead of manual `Web5Helper.createRecord()` /
  `Web5Helper.readRecord()` calls. Import `ProfileProtocol` from `@enbox/protocols`
  (the `defineProtocol()` wrapper) instead of `ProfileDefinition` (the raw object).

### 2. Add Preferences support

- Install `PreferencesDefinition` alongside Profile and Connect during identity
  creation/import in `IdentitiesContext.tsx`
- Add a settings page or section for theme and locale preferences
- Use `web5.using(PreferencesProtocol)` for CRUD

### 3. Install Social Graph

- Install `SocialGraphDefinition` during identity creation/import (required dependency
  for Profile's `privateNote` cross-protocol role)
- No UI needed immediately, but the protocol must be present for full Profile
  functionality

---

## WS4b: Demo Dapp (`examples/dapp-demo/`)

### 1. Adopt typed protocol API

- **`src/lib/todo-dwn-repository.ts`** -- Rewrite to use `web5.using(ListsProtocol)` with
  typed `write()` / `query()` / `delete()` instead of raw `dwn.records.create()` calls
- **`src/components/profile-settings.tsx`** -- Use `web5.using(ProfileProtocol)` for
  profile read/write
- Remove thin re-export shims (`src/protocols/tasks.ts`, `src/protocols/profile.ts`) and
  import directly from `@enbox/protocols`

### 2. Install remaining protocols

- **`src/web5/protocols.ts`** -- Add `SocialGraphDefinition` to `installProtocols()`.
  Install order: Social Graph first, then Profile, Lists, Connect (Social Graph is a
  dependency of Profile and Lists)
- Preferences and Status can be added later when corresponding UI pages are built

### 3. Update wallet connect permission requests

- **`src/components/connect/connect-selector.tsx`** -- Add `SocialGraphDefinition` to
  `permissionRequests` so the wallet grants access to the social graph protocol

---

## Validation

After each app is updated:

1. `bun install` from repo root
2. `bun run build` succeeds for the affected example
3. Manual smoke test: create identity / connect, create records, verify typed API is used
