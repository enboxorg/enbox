# @enbox/auth

## 0.3.0

### Minor Changes

- [#594](https://github.com/enboxorg/enbox/pull/594) [`d20a8b9`](https://github.com/enboxorg/enbox/commit/d20a8b9299db09290303e679115a5eeb144c2469) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Support custom agent, vault, and local DWN strategy in AuthManager.create()

  - Add `agent`, `agentVault`, and `localDwnStrategy` options to `AuthManagerOptions`
  - When a pre-built `Web5UserAgent` is provided, it is used as-is (escape hatch for custom DWN stores)
  - Re-export `Web5UserAgent` and `HdIdentityVault` classes from `@enbox/agent` so consumers don't need a direct dependency
  - Re-export `LocalDwnStrategy` type
  - 5 new tests covering all custom agent creation paths, 169 total tests passing

- [#584](https://github.com/enboxorg/enbox/pull/584) [`b147be2`](https://github.com/enboxorg/enbox/commit/b147be2d2e5cb20d9265b86bf38cedc42b19b178) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add DWN registration support to all connection flows

  - Expand `RegistrationOptions` with provider-auth callbacks (`onProviderAuthRequired`, `registrationTokens`, `onRegistrationTokens`)
  - Add `ProviderAuthParams`, `ProviderAuthResult`, and `RegistrationTokenData` types
  - Create `registerWithDwnEndpoints()` flow supporting provider-auth-v0 (with token refresh) and PoW fallback
  - Wire registration into `connect()`, `walletConnect()`, `importFromPhrase()`, and `importFromPortable()` flows
  - Add `@enbox/dwn-clients` as a dependency for `DwnRegistrar`
  - Add `rpc.getServerInfo` mock to test helper
  - 17 new tests covering all registration paths, 99.68% line coverage

### Patch Changes

- [#582](https://github.com/enboxorg/enbox/pull/582) [`a48bdd4`](https://github.com/enboxorg/enbox/commit/a48bdd4b6f9261821ad9470ce849699bc045c80f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add LevelDB-backed `LevelStorage` adapter as the default storage for Node/CLI environments, replacing the in-memory fallback that lost session data on process exit.

- [#628](https://github.com/enboxorg/enbox/pull/628) [`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - BREAKING: Rename Web5-prefixed symbols to Enbox-prefixed across agent and dwn-clients

  - `Web5Agent` → `EnboxAgent`, `Web5UserAgent` → `EnboxUserAgent`, `Web5PlatformAgent` → `EnboxPlatformAgent`
  - `Web5RpcClient` → `EnboxRpcClient`, `Web5Rpc` → `EnboxRpc`, `HttpWeb5RpcClient` → `HttpEnboxRpcClient`, `WebSocketWeb5RpcClient` → `WebSocketEnboxRpcClient`
  - `Web5ConnectAuthRequest` → `EnboxConnectAuthRequest`, `Web5ConnectAuthResponse` → `EnboxConnectAuthResponse`
  - Deprecated aliases preserved for all renamed symbols
  - File renamed: `web5-user-agent.ts` → `enbox-user-agent.ts`
  - All downstream packages updated: @enbox/api, @enbox/auth

- [#643](https://github.com/enboxorg/enbox/pull/643) [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Update remaining Web5 references in JSDoc, comments, and package metadata to Enbox

  - Replace ~60 stale "Web5" references in JSDoc/comments across agent, api, auth, browser, crypto, and dwn-server packages
  - Update package.json descriptions for @enbox/crypto and @enbox/browser
  - Fix typo in dwn-server http-api.ts ("am enbox" → "an enbox")
  - Update code examples in @enbox/auth to use `Enbox.connect()` instead of `new Web5()`

- Updated dependencies [[`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b), [`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/agent@0.3.0
  - @enbox/dwn-clients@0.1.0
  - @enbox/common@0.0.7
  - @enbox/dids@0.0.9

## 0.2.0

### Minor Changes

- [#579](https://github.com/enboxorg/enbox/pull/579) [`68b0ea9`](https://github.com/enboxorg/enbox/commit/68b0ea9728f95d81fa6d7657df8bc78ba2f83814) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: introduce @enbox/auth — headless authentication & identity SDK

  New package providing composable, multi-identity-aware authentication that replaces `Web5.connect()`. Depends only on `@enbox/agent`, `@enbox/common`, and `@enbox/dids` with zero dependency on `@enbox/api`.

  Key capabilities:

  - `AuthManager` orchestrator with local connect, wallet connect, import, and session restore flows
  - `AuthSession` exposing `agent`, `did`, `delegateDid` primitives (no `web5` getter — that's `@enbox/api`'s layer)
  - Multi-identity support: list, switch, delete, export identities
  - `VaultManager` wrapping `HdIdentityVault` with typed events
  - Platform-agnostic `StorageAdapter` with browser and memory implementations
  - `processConnectedGrants()` reimplemented using agent primitives
