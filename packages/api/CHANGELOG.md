# @enbox/api

## 0.2.1

### Patch Changes

- Updated dependencies [[`8a2f650`](https://github.com/enboxorg/enbox/commit/8a2f650c88f4b78f415dcacc23d7f4c82bc9a67b)]:
  - @enbox/agent@0.1.7

## 0.2.0

### Minor Changes

- [#242](https://github.com/enboxorg/enbox/pull/242) [`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.

### Patch Changes

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/agent@0.1.6
  - @enbox/dwn-clients@0.0.4

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.1.5
  - @enbox/dwn-clients@0.0.3

## 0.1.0

### Minor Changes

- Add typed protocol API: defineProtocol() factory, TypedDwnApi class with type-safe write/query/read/delete/subscribe/configure methods, DwnApi.using() entry point, and generic Record.data.json<T>() return type

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.1.4
  - @enbox/dwn-clients@0.0.2

## 0.0.8

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/common@0.0.3
  - @enbox/agent@0.1.3

## 0.0.7

### Patch Changes

- [#147](https://github.com/enboxorg/enbox/pull/147) [`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish new versions to fix MessagesSync export chain

  @enbox/agent@0.1.1 imports MessagesSync from @enbox/dwn-sdk-js, but
  @enbox/dwn-sdk-js@0.0.2 was published before that export was added.
  This bumps all three packages so downstream consumers (demo apps) can
  resolve the full dependency chain.

- Updated dependencies [[`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca)]:
  - @enbox/agent@0.1.2

## 0.0.6

### Patch Changes

- [#140](https://github.com/enboxorg/enbox/pull/140) [`3120dd0`](https://github.com/enboxorg/enbox/commit/3120dd0d2ffc0977d331d297af0665d5593b2d4e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: republish with correct @enbox/agent@0.1.1 dependency

  Previous attempts resolved workspace:_ to @enbox/agent@0.1.0 because bun
  kept the stale lockfile resolution. This release regenerates the lockfile
  from scratch so workspace:_ correctly resolves to @enbox/agent@0.1.1.

## 0.0.5

### Patch Changes

- [#135](https://github.com/enboxorg/enbox/pull/135) [`bd7399d`](https://github.com/enboxorg/enbox/commit/bd7399d850609fad8e01672378d3e8ac42d7f5a3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: republish with correct @enbox/agent dependency version

  The previous @enbox/api@0.0.4 was published with a dependency on
  @enbox/agent@0.1.0 (which has broken workspace:_ references) instead of
  @enbox/agent@0.1.1. This happened because the lockfile was stale when
  bun pm pack resolved the workspace:_ reference.

  The release workflow now regenerates the lockfile after version bumps
  to prevent this from recurring.

## 0.0.4

### Patch Changes

- [#128](https://github.com/enboxorg/enbox/pull/128) [`6e5401f`](https://github.com/enboxorg/enbox/commit/6e5401fbd72bf5dabccf71fa592bf14b2fe6eb8a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: republish with resolved workspace dependencies

  The previous releases of @enbox/agent@0.1.0 and @enbox/api@0.0.3 contained
  literal `workspace:*` strings in their published dependencies, making them
  uninstallable outside the monorepo. This patch release uses `bun publish`
  which correctly resolves workspace references to actual version numbers.

- Updated dependencies [[`6e5401f`](https://github.com/enboxorg/enbox/commit/6e5401fbd72bf5dabccf71fa592bf14b2fe6eb8a)]:
  - @enbox/agent@0.1.1

## 0.0.3

### Patch Changes

- [#46](https://github.com/enboxorg/enbox/pull/46) [`b0aca19`](https://github.com/enboxorg/enbox/commit/b0aca19fbbf0828184e2413f0c5cf9fd4274ea56) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Consolidate @enbox/user-agent, @enbox/proxy-agent, and @enbox/identity-agent into @enbox/agent. The Web5UserAgent class is now exported directly from @enbox/agent. The separate packages are deprecated.

- Updated dependencies [[`b0aca19`](https://github.com/enboxorg/enbox/commit/b0aca19fbbf0828184e2413f0c5cf9fd4274ea56)]:
  - @enbox/agent@0.1.0

This package is a fork of the official Web5 API package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/web5-js](https://github.com/decentralized-identity/web5-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
