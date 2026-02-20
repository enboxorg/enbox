# @enbox/dwn-sql-store

## 0.0.6

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.0.6

## 0.0.5

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.0.5

## 0.0.4

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/dwn-sdk-js@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [[`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca)]:
  - @enbox/dwn-sdk-js@0.0.3

This package is a fork of the official DWN SQL Store package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store)

All changes, releases, and updates are tracked in the upstream repository's changelog.
