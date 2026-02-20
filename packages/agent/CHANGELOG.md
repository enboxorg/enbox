# @enbox/agent

## 0.1.4

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.0.5
  - @enbox/dwn-clients@0.0.2

## 0.1.3

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/common@0.0.3
  - @enbox/crypto@0.0.3
  - @enbox/dids@0.0.3
  - @enbox/dwn-sdk-js@0.0.4

## 0.1.2

### Patch Changes

- [#147](https://github.com/enboxorg/enbox/pull/147) [`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish new versions to fix MessagesSync export chain

  @enbox/agent@0.1.1 imports MessagesSync from @enbox/dwn-sdk-js, but
  @enbox/dwn-sdk-js@0.0.2 was published before that export was added.
  This bumps all three packages so downstream consumers (demo apps) can
  resolve the full dependency chain.

- Updated dependencies [[`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca)]:
  - @enbox/dwn-sdk-js@0.0.3

## 0.1.1

### Patch Changes

- [#128](https://github.com/enboxorg/enbox/pull/128) [`6e5401f`](https://github.com/enboxorg/enbox/commit/6e5401fbd72bf5dabccf71fa592bf14b2fe6eb8a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: republish with resolved workspace dependencies

  The previous releases of @enbox/agent@0.1.0 and @enbox/api@0.0.3 contained
  literal `workspace:*` strings in their published dependencies, making them
  uninstallable outside the monorepo. This patch release uses `bun publish`
  which correctly resolves workspace references to actual version numbers.

## 0.1.0

### Minor Changes

- [#46](https://github.com/enboxorg/enbox/pull/46) [`b0aca19`](https://github.com/enboxorg/enbox/commit/b0aca19fbbf0828184e2413f0c5cf9fd4274ea56) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Consolidate @enbox/user-agent, @enbox/proxy-agent, and @enbox/identity-agent into @enbox/agent. The Web5UserAgent class is now exported directly from @enbox/agent. The separate packages are deprecated.

This package is a fork of the official Web5 Agent package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/web5-js](https://github.com/decentralized-identity/web5-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
