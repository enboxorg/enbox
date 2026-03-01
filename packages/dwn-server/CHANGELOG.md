# @enbox/dwn-server

## 0.0.9

### Patch Changes

- [#642](https://github.com/enboxorg/enbox/pull/642) [`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: rename Web5-prefixed symbols in common and dwn-server packages

  - `@enbox/common`: `Web5LogLevel` -> `LogLevel`, `Web5LoggerInterface` -> `LoggerInterface`, `Web5Logger` -> `EnboxLogger`, `window.web5logger` -> `window.enboxLogger`
  - `@enbox/dwn-server`: `Web5ConnectServer` -> `ConnectServer`, `Web5ConnectRequest` -> `ConnectRequest`, `Web5ConnectResponse` -> `ConnectResponse`, `SetWeb5ConnectRequestResult` -> `SetConnectRequestResult`
  - Moved `src/web5-connect/` -> `src/connect/` and `tests/web5-connect/` -> `tests/connect/`
  - Deprecated aliases preserved for backward compatibility

- [#643](https://github.com/enboxorg/enbox/pull/643) [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Update remaining Web5 references in JSDoc, comments, and package metadata to Enbox

  - Replace ~60 stale "Web5" references in JSDoc/comments across agent, api, auth, browser, crypto, and dwn-server packages
  - Update package.json descriptions for @enbox/crypto and @enbox/browser
  - Fix typo in dwn-server http-api.ts ("am enbox" → "an enbox")
  - Update code examples in @enbox/auth to use `Enbox.connect()` instead of `new Web5()`

- Updated dependencies [[`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b), [`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/dwn-clients@0.1.0
  - @enbox/common@0.0.7
  - @enbox/crypto@0.0.8
  - @enbox/dids@0.0.9
  - @enbox/dwn-sdk-js@0.1.2
  - @enbox/dwn-sql-store@0.0.11

## 0.0.8

### Patch Changes

- Updated dependencies [[`7a68c55`](https://github.com/enboxorg/enbox/commit/7a68c5509da7d01700240b630ac529cbf94a629a)]:
  - @enbox/dwn-clients@0.0.9

## 0.0.7

### Patch Changes

- [#541](https://github.com/enboxorg/enbox/pull/541) [`f484270`](https://github.com/enboxorg/enbox/commit/f4842708cbf378ae854105487fa73e880aba806a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Allow passing RegistrationManager and OpenAuthHandler via DwnServerOptions when using a pre-built DWN instance. This enables registration endpoints and open-auth flow for consumers like dwn-relay that construct their own DWN with custom store wrappers. Also exports RegistrationManager and OpenAuthHandler from the package index.

## 0.0.6

### Patch Changes

- [#539](https://github.com/enboxorg/enbox/pull/539) [`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish unpublished fixes across packages

  - `@enbox/common`: `open()` in KeyValueStore interface
  - `@enbox/dids`: `DidResolverCacheMemory`, resolver lifecycle management
  - `@enbox/dwn-sdk-js`: `DidResolverCacheMemory` default in `Dwn.create()` (fixes "Database is not open" in containers)
  - `@enbox/dwn-clients`: `DwnServerInfoCacheMemory`
  - `@enbox/dwn-server`: Actor delivery, noop resolver cache, registration gate fix

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/common@0.0.6
  - @enbox/dids@0.0.8
  - @enbox/dwn-sdk-js@0.1.1
  - @enbox/dwn-clients@0.0.8
  - @enbox/crypto@0.0.7
  - @enbox/dwn-sql-store@0.0.10

This package is a fork of the official DWN Server package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/dwn-server](https://github.com/decentralized-identity/dwn-server)

All changes, releases, and updates are tracked in the upstream repository's changelog.
