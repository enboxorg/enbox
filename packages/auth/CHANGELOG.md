# @enbox/auth

## 0.6.7

### Patch Changes

- Updated dependencies [[`d6b643d`](https://github.com/enboxorg/enbox/commit/d6b643ddab34bf8d82226c368727a3566ae84d48)]:
  - @enbox/agent@0.5.4

## 0.6.6

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2
  - @enbox/agent@0.5.3
  - @enbox/dwn-clients@0.2.3

## 0.6.5

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1
  - @enbox/agent@0.5.2
  - @enbox/dwn-clients@0.2.2

## 0.6.4

### Patch Changes

- [#738](https://github.com/enboxorg/enbox/pull/738) [`5f3e33e`](https://github.com/enboxorg/enbox/commit/5f3e33edf3dee9268716c8ac8c049da3abf010e4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): allow sync: 'off' for delegated connect flows

  Remove the restriction that forced sync to be enabled for
  walletConnect() and handler-based connect(). The sync engine's
  SMT tree walk generates hundreds of HTTP requests during initial
  reconciliation, easily exceeding DWN server rate limits.

  Dapps can now opt out of sync with `sync: 'off'` and rely on
  local DWN operations only. The `startSyncIfEnabled()` helper
  already handles sync: 'off' as a no-op.

## 0.6.3

### Patch Changes

- [#736](https://github.com/enboxorg/enbox/pull/736) [`4c7c71e`](https://github.com/enboxorg/enbox/commit/4c7c71efa25a1eee115ef30424bc6c97189aa8f3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): remove redundant sync pull from importDelegateAndSetupSync

  The manual `sync('pull')` call was immediately followed by
  `startSyncIfEnabled()` which runs its own immediate sync cycle.
  This doubled the startup burst and could trigger 429 rate limits
  on the remote DWN server.

## 0.6.2

### Patch Changes

- [#728](https://github.com/enboxorg/enbox/pull/728) [`ef5dc9b`](https://github.com/enboxorg/enbox/commit/ef5dc9b28527538205c0e08032017649ba20964d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): add 'configure' to DEFAULT_PERMISSIONS

  Include `ProtocolsConfigure` in the default permission set requested
  during `connect()`. Without this, dapps using the standard `TypedEnbox`
  API fail with "No permissions found for ProtocolsConfigure" because
  `_autoConfigureOnce()` needs a configure grant to install the protocol
  on the delegate's local DWN.

## 0.6.1

### Patch Changes

- Updated dependencies [[`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7), [`fc923cb`](https://github.com/enboxorg/enbox/commit/fc923cb6a1f6d8e56f616a69d3e61345898d2cf9)]:
  - @enbox/agent@0.5.1
  - @enbox/dwn-clients@0.2.1

## 0.6.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531)]:
  - @enbox/agent@0.5.0
  - @enbox/dwn-clients@0.2.0
  - @enbox/common@0.1.0
  - @enbox/crypto@0.1.0
  - @enbox/dwn-sdk-js@0.2.0
  - @enbox/dids@0.1.0

## 0.5.0

### Minor Changes

- [#714](https://github.com/enboxorg/enbox/pull/714) [`fd02228`](https://github.com/enboxorg/enbox/commit/fd02228b247aa5de903051155813ce49f210b62c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove port probing and add remote DWN mode

  **@enbox/agent:**

  - Add remote DWN mode: when `localDwnEndpoint` is provided, skip creating an in-process DWN and route all operations through RPC to the local DWN server.
  - Add `processRawMessage()` for the sync engine to store pre-constructed messages via RPC.
  - Add `isRemoteMode` getter on `AgentDwnApi`.
  - Remove `localDwnPortCandidates` and `localDwnHostCandidates` exports (port probing removed).
  - Remove `dwn-record-upgrade` export (disabled, kept as reference).
  - `node` getter now throws in remote mode with a clear error message.

  **@enbox/auth:**

  - Add `discoverLocalDwn()` standalone function that runs before agent creation with zero vault/DWN dependencies.
  - `AuthManager.create()` now runs local DWN discovery before creating the agent, enabling remote mode when a local server is available.
  - Add `localDwnEndpoint` getter on `AuthManager`.
  - Remove `probeLocalDwn()` export (port probing removed).
  - Skip `applyLocalDwnDiscovery()` in connect/restore flows when already in remote mode.

### Patch Changes

- Updated dependencies [[`fd02228`](https://github.com/enboxorg/enbox/commit/fd02228b247aa5de903051155813ce49f210b62c)]:
  - @enbox/agent@0.4.0

## 0.4.0

### Minor Changes

- [#667](https://github.com/enboxorg/enbox/pull/667) [`2d2d4b1`](https://github.com/enboxorg/enbox/commit/2d2d4b1fd1400d1d8983ed17576a329da226b104) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `lock()`, `switchIdentity()` sync registration, and `onPasswordRequired` callback

  - **`AuthManager.lock()`**: New top-level method that stops sync, clears the active session, locks the vault, and transitions to `'locked'` state. Session storage markers are preserved so `restoreSession()` can reconnect after unlock.
  - **`switchIdentity()` sync registration**: Now calls `sync.registerIdentity()` for the target identity before starting sync, ensuring imported or newly-switched identities are properly registered for DWN synchronization.
  - **`onPasswordRequired` callback**: New optional callback on `RestoreSessionOptions` that is invoked when the vault is locked and a password is needed. This enables interactive password prompts (PIN dialogs, CLI prompts) without pre-supplying a password.

## 0.3.1

### Patch Changes

- Updated dependencies [[`22d724e`](https://github.com/enboxorg/enbox/commit/22d724eb415b3eea71983ab6aecd5810efa8c6bc)]:
  - @enbox/agent@0.3.1

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
