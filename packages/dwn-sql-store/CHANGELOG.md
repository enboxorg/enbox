# @enbox/dwn-sql-store

## 0.0.12

### Patch Changes

- Updated dependencies [[`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531)]:
  - @enbox/dwn-sdk-js@0.2.0

## 0.0.11

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.1.2

## 0.0.10

### Patch Changes

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/dwn-sdk-js@0.1.1

## 0.0.9

### Patch Changes

- [#514](https://github.com/enboxorg/enbox/pull/514) [`0eb40d4`](https://github.com/enboxorg/enbox/commit/0eb40d4d111732262de01258c0f7f8c727466714) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: $squash protocol directive, live sync engine, record delivery, security hardening

  - dwn-sdk-js: add $squash protocol directive for RecordsWrite, record delivery and endpoint forwarding
  - agent: live sync engine with real-time subscriptions and connectivity awareness
  - api: live sync engine integration
  - common: escape LIKE wildcards, remove Math.random from public API
  - dids: add fetch timeouts and SSRF protection for did:web resolution
  - browser: add deactivatePolyfills, clearDrlCache, configurable resolvers, strict TypeScript mode
  - dwn-clients: properly signal rate limiting to clients
  - dwn-sql-store: add squash column migration and message store adjustments

- Updated dependencies [[`0eb40d4`](https://github.com/enboxorg/enbox/commit/0eb40d4d111732262de01258c0f7f8c727466714)]:
  - @enbox/dwn-sdk-js@0.1.0

## 0.0.8

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/dwn-sdk-js@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/dwn-sdk-js@0.0.7

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
