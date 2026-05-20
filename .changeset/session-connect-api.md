---
"@enbox/agent": minor
"@enbox/api": major
"@enbox/auth": minor
"@enbox/browser": patch
"@enbox/common": minor
"@enbox/dwn-sdk-js": patch
---

Add shared agent sessions and high-level Enbox connection helpers.

**Breaking changes** (pre-1.0; documented here per AGENTS.md):

- **`Enbox.connect()` signature changed from synchronous → async.** It now returns `Promise<{ auth, enbox, session }>` instead of `Enbox`. Code like `const enbox = Enbox.connect({ session })` must migrate to either `const enbox = Enbox.fromSession(session)` (caller-owned session) or `const { enbox } = await Enbox.connect({...})` (high-level managed flow). `@enbox/api` is bumped **major** because of this.
- **`AuthManager._isLocalConnect()` precedence flipped.** Handler signals (`protocols`, `connectHandler`) now win over local-style defaults (`password`, `dwnEndpoints`, `metadata`, `createIdentity`, `recoveryPhrase`). A non-empty `protocols` array OR a `connectHandler` selects the handler flow; everything else (including the no-options case, an empty `protocols: []`, and a `null` handler) routes to local. `@enbox/auth` is bumped **minor**.
- **`AgentSessionPrimitives.agent` widened from `EnboxAgent` to `EnboxPlatformAgent`.** Every real session is bound to a platform-shaped agent (vault, sync, secrets), so the previous narrow type lied about what consumers could call. Code that constructed an `AgentSession`/`AuthSession` with a non-platform `EnboxAgent` will need to pass a platform agent.

**New surface in `@enbox/agent`:**

- `AgentSession` class plus the `AgentSessionPrimitives` base, so the minimal `{ agent, did, delegateDid? }` session shape lives in one place.

**New surface in `@enbox/api`:**

- `Enbox.fromSession(session)` — synchronous, accepts any session-shaped object (including `AuthSession` and custom shapes).
- `Enbox.connect(options?)` — asynchronous, creates an `AuthManager`, runs `auth.connect()`, and returns `{ auth, enbox, session }`. Owns the `AuthManager` lifecycle: a single `await enbox.disconnect()` tears down vault + storage + sync.
- For raw `{ agent, connectedDid }` access, use `new Enbox(params)` (the public constructor — `Enbox.from()` from earlier iterations of this PR was removed).
- `EnboxConnectOptions` flat-intersects manager + per-call options with an optional `connectOverride` slot. An empty `connectOverride: {}` is treated as "no override" so it can't accidentally bypass smart routing or a manager-level `connectHandler`.
- Concurrency guard: two parallel `Enbox.connect()` invocations against the same `dataPath` reject the second with a clear domain-level error instead of racing on the LevelDB lock.
- `auth.shutdown()` failures during error recovery are now surfaced via `console.warn` while the original `connect` error still propagates.

**New surface in `@enbox/auth`:**

- `AuthSession` is now an alias for `AgentSession` from `@enbox/agent` (`export { AgentSession as AuthSession }`). The constructor contract is unchanged; `instanceof` checks succeed against both names.
- `IdentityInfo` is a `@deprecated` alias for `AgentSessionIdentity`.
- `HandlerConnectOptions.password?` accepts a per-call password override (previously silently dropped).
- The auth-manager exposes the `@enbox/auth/auth-manager` subpath; it's marked `@internal` and is intended for monorepo use only.
- `_handlerConnect` now resolves the connect handler **before** initializing the vault, so a misconfigured handler-flow call cannot leak an initialized vault to disk.
- `_isLocalConnect` rewritten as a TypeScript type-guard with companion `_isHandlerConnect`. The handler predicate uses positive narrowing: a non-empty `protocols` array OR a non-null `connectHandler` selects handler flow.
- All `connect` / `restoreSession` / `connectHeadless` entry points guard against re-use after `shutdown()` and throw a clear domain error rather than failing deep in sync/storage internals.
- The "no password set" security warning now also fires when an explicit empty-string password is supplied.

**New surface in `@enbox/common`:**

- `omitUndefined<T>(input)` — immutable, shallow, typed companion to `removeUndefinedProperties` (which remains mutating and recursive). Use the variant that matches the call site.
- `@enbox/common` is now the single source of truth for object-shape helpers across the monorepo. `@enbox/dwn-sdk-js/utils/object.ts` re-exports from `@enbox/common` rather than holding its own near-duplicate copy of `isEmptyObject` / `removeEmptyObjects` / `removeUndefinedProperties`. This is a behavior-preserving change for every existing call site **except** `isEmptyObject(null)`, which used to throw `TypeError: Object.keys(null)` and now returns `false` — a latent crash that no DWN code path was hitting in practice.

**`@enbox/browser`** re-exports the new `EnboxSession*` / `EnboxConnect*` types so dapps don't have to reach into `@enbox/api` for explicit annotations.
