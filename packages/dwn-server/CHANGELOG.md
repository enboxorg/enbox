# @enbox/dwn-server

## 0.0.12

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1
  - @enbox/dwn-clients@0.2.2
  - @enbox/dwn-sql-store@0.0.13

## 0.0.11

### Patch Changes

- [#721](https://github.com/enboxorg/enbox/pull/721) [`fc923cb`](https://github.com/enboxorg/enbox/commit/fc923cb6a1f6d8e56f616a69d3e61345898d2cf9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(dwn-server): include CORS headers on per-IP rate-limit 429 responses so browsers can read the error instead of treating it as a CORS failure

  fix(agent): throttle sync engine remote requests to prevent rate-limit bursts — tree walk is now gated by a semaphore (max 4 concurrent remote requests) and pull concurrency reduced from 10 to 4

- Updated dependencies [[`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7)]:
  - @enbox/dwn-clients@0.2.1

## 0.0.10

### Patch Changes

- [#717](https://github.com/enboxorg/enbox/pull/717) [`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: consolidate connect flows, remove all deprecated Web5 aliases, remove dead abstractions

  BREAKING CHANGES:

  **@enbox/agent**

  - `WalletConnect` namespace moved to `@enbox/auth` — import from `@enbox/auth` instead
  - `AgentSyncApi` removed — `EnboxUserAgent.sync` is now typed as `SyncEngine` directly
  - `Web5Agent`, `Web5PlatformAgent`, `Web5UserAgent` type aliases removed
  - `PushedAuthRequest`, `PushedAuthResponse` types removed
  - `Oidc` namespace removed — use `EnboxConnectProtocol` instead
  - `EnboxConnectAuthRequest`/`EnboxConnectAuthResponse` types removed — use `EnboxConnectRequest`/`EnboxConnectResponse`
  - `DwnDidService.enc`/`.sig` fields removed from `types/dwn.ts`

  **@enbox/api**

  - `Web5`, `Web5Params`, `Web5AnonymousOptions`, `Web5AnonymousApi` aliases removed — use `Enbox` equivalents

  **@enbox/dwn-clients**

  - `Web5Rpc`, `Web5RpcClient`, `HttpWeb5RpcClient`, `WebSocketWeb5RpcClient` aliases removed — use `DwnRpc`/`DwnRpcClient`/`HttpDwnRpcClient`/`WebSocketDwnRpcClient`

  **@enbox/common**

  - `Web5LogLevel`, `Web5LoggerInterface` aliases removed — use `EnboxLogLevel`/`EnboxLoggerInterface`

  **@enbox/crypto**

  - `ExtendedCryptoApi` removed (was unused)

  **@enbox/dwn-sdk-js**

  - `MessageSubscriptionHandler`, `RecordSubscriptionHandler` type aliases removed — use `SubscriptionListener`

  **@enbox/dids**

  - `DwnDidService.enc`/`.sig` fields removed — these were never consumed by production code

  **@enbox/dwn-server** (patch — internal only)

  - `Web5ConnectRequest`, `Web5ConnectResponse`, `SetWeb5ConnectRequestResult`, `Web5ConnectServer` internal aliases removed

  Non-breaking changes:

  - `close()` added to `SyncEngine` interface
  - Connect flow helpers deduplicated into `@enbox/auth/connect/lifecycle.ts`
  - `WalletConnect` client moved to `@enbox/auth` (new export, minor bump)

- Updated dependencies [[`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531)]:
  - @enbox/dwn-clients@0.2.0
  - @enbox/common@0.1.0
  - @enbox/crypto@0.1.0
  - @enbox/dwn-sdk-js@0.2.0
  - @enbox/dids@0.1.0
  - @enbox/dwn-sql-store@0.0.12

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
