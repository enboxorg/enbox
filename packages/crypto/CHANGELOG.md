# @enbox/crypto

## 0.0.5

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/common@0.0.4

## 0.0.4

### Patch Changes

- [#202](https://github.com/enboxorg/enbox/pull/202) [`af2ba3a`](https://github.com/enboxorg/enbox/commit/af2ba3a7e9d5de44b40a38169e9296427a4f049b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(crypto): publish updated barrel with algorithm class exports

  The `@enbox/crypto@0.0.3` dist was built before the algorithm barrel
  exports (`AesKwAlgorithm`, `HkdfAlgorithm`, `Pbkdf2Algorithm`,
  `X25519Algorithm`, `EciesSecp256k1`) were added to `index.ts`.
  `@enbox/agent@0.1.4` imports these symbols, causing Vite/Rollup build
  failures in downstream apps (`"AesKwAlgorithm" is not exported`).

  The source was already correct — this bump triggers a fresh publish so
  the dist matches the source.

## 0.0.3

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/common@0.0.3

This package is a fork of the official Web5 Crypto package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/web5-js](https://github.com/decentralized-identity/web5-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
