# @enbox/agent

## 0.5.9

### Patch Changes

- [#759](https://github.com/enboxorg/enbox/pull/759) [`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(dwn-sdk-js): include encodedData in EventLog emit for live sync

  fix(agent): handle inline encodedData in live pull and fetch data for large records

  Three changes that make live WebSocket sync deliver complete records:

  1. RecordsWriteHandler now emits `messageWithOptionalEncodedData` (with
     inline `encodedData` for records <= 30 KB) to the EventLog instead of
     the raw message. WebSocket subscribers receive complete small records
     without a separate MessagesRead round-trip.

  2. The sync engine's `extractDataStream` now decodes inline `encodedData`
     from WebSocket events into a ReadableStream. For large records (no
     inline data), it fetches the data from the remote DWN via MessagesRead
     before storing locally.

  3. RecordsWriteHandler now allows re-processing of the same message when
     the existing copy was stored as an incomplete initial write (204, no
     data) and the incoming message supplies data. This repairs records
     that were previously "poisoned" by live sync storing them without data.

  4. MessagesSyncHandler diff inline threshold lowered from 256 KB to 30 KB
     to match the MessageStore's encodedData threshold, keeping diff
     responses lightweight.

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/dwn-sdk-js@0.3.0
  - @enbox/dwn-clients@0.2.4

## 0.5.8

### Patch Changes

- [#757](https://github.com/enboxorg/enbox/pull/757) [`3ce537a`](https://github.com/enboxorg/enbox/commit/3ce537a4f5e5137b6cedf65af50c33ddbdf6a6a2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(agent): route live pull subscriptions to specific dwnUrl instead of first-resolved endpoint

  openLivePullSubscription used agent.dwn.sendRequest({ target: did }) which
  resolves all DWN endpoints from the DID document and connects to the first
  one. When a DID has multiple endpoints, the pull subscription could connect
  to a different server than the one receiving push writes — so events pushed
  to server A were never relayed to the subscriber on server B.

  Now constructs the MessagesSubscribe message via processRequest and sends it
  directly to the specific dwnUrl (converted to wss://) via agent.rpc.sendDwnRequest,
  ensuring the pull subscription is on the same server that receives pushes for
  that sync target. Also includes a resubscribe factory for cursor-based resume
  on WebSocket reconnection.

## 0.5.7

### Patch Changes

- [#755](https://github.com/enboxorg/enbox/pull/755) [`e269cbf`](https://github.com/enboxorg/enbox/commit/e269cbf58cf7c29fc0e1e7865ecfa7f42ea54122) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): await startSyncIfEnabled so sync is fully initialized before connect returns

  fix(agent): replace broken tryGetCidSync with async Message.getCid in local push handler

  Two fixes for live and poll sync:

  1. startSyncIfEnabled was fire-and-forget at all 6 call sites, causing a
     race where sync started before grants were persisted. Now awaited.

  2. tryGetCidSync attempted to compute a SHA-256 CID synchronously via a
     fire-and-forget microtask — the CID was always undefined, causing every
     local write event to be silently dropped. Replaced with an async handler
     that awaits Message.getCid() directly.

## 0.5.6

### Patch Changes

- [#752](https://github.com/enboxorg/enbox/pull/752) [`682fb85`](https://github.com/enboxorg/enbox/commit/682fb858343319e3a4da54b08017382596896d6a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(agent): propagate permission errors in live sync subscription setup

  openLivePullSubscription and openLocalPushSubscription were silently
  returning when the delegate permission grant lookup failed, causing live
  WebSocket sync to silently do nothing. Errors now propagate to the
  startLiveSync catch block so they are visible in the console.

- [#754](https://github.com/enboxorg/enbox/pull/754) [`c8360c3`](https://github.com/enboxorg/enbox/commit/c8360c3856eebec89d717003fe3e0e21a9f182fe) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: eliminate silent error swallowing anti-patterns across agent and auth

  Comprehensive audit of all try/catch blocks that silently swallow errors.
  Five fixes:

  1. **Security**: Password provider errors now log the error before falling
     through to the insecure default, so developers can distinguish "provider
     threw" from "no provider configured".

  2. **Correctness**: Remote protocol definition fetch now only treats
     "not found" responses as missing protocols. Transient errors (network,
     auth) are rethrown so the caller does not silently skip encryption.

  3. **Data integrity**: Identity deletion now propagates DID/key deletion
     errors instead of deleting the identity record anyway, which would
     leave orphaned cryptographic key material.

  4. **Debuggability**: Corrupt sync identity options in LevelDB now log a
     warning before falling back to global sync.

  5. **Correctness**: `registerIdentity` during session restore now only
     catches "already registered" errors; other errors (LevelDB failures)
     are rethrown.

## 0.5.5

### Patch Changes

- [#748](https://github.com/enboxorg/enbox/pull/748) [`3910ebb`](https://github.com/enboxorg/enbox/commit/3910ebb5b25d29161359d7ffa426ac85534f16a6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): store delegate grants in both delegate and connected DID partitions

  fix(agent): propagate permission grant errors instead of swallowing them

  Permission grants are now stored in both the delegateDid's and connectedDid's
  local DWN partitions during the connect flow. Previously grants were only
  stored in the delegateDid partition, but the DWN needs them in the connectedDid
  partition to authorize delegate operations (MessagesRead, MessagesSync) against
  that tenant. This caused sync push to silently skip all messages.

  Grant lookup failures in the sync engine now throw instead of being silently
  swallowed. When a delegateDid is present, the grant is mandatory — returning
  undefined caused downstream operations to proceed without authorization and
  fail silently.

## 0.5.4

### Patch Changes

- [#746](https://github.com/enboxorg/enbox/pull/746) [`d6b643d`](https://github.com/enboxorg/enbox/commit/d6b643ddab34bf8d82226c368727a3566ae84d48) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(agent): send permission grants to all DWN endpoints during connect

## 0.5.3

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2
  - @enbox/dwn-clients@0.2.3

## 0.5.2

### Patch Changes

- [#741](https://github.com/enboxorg/enbox/pull/741) [`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(sync): batched diff protocol and direct StateIndex access

  Add a new `MessagesSync` `action: 'diff'` that collapses the entire SMT tree walk and message fetch into a single HTTP round-trip. The client sends its subtree hashes at a configurable depth, and the server returns the full set difference with inline message data for small payloads. Also bypass the `processMessage` pipeline for local SMT queries by accessing the `StateIndex` directly when the agent has an in-process DWN, with transparent RPC fallback for remote mode. Includes stream-aware retry that buffers small data payloads to avoid re-fetching on transient failures.

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1
  - @enbox/dwn-clients@0.2.2

## 0.5.1

### Patch Changes

- [#719](https://github.com/enboxorg/enbox/pull/719) [`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7) Thanks [@csuwildcat](https://github.com/csuwildcat)! - fix(agent): prefer locally-stored BearerDid for signing, avoiding unnecessary DID resolution round-trips that can fail on malformed cached data

  fix(dwn-clients): handle ReadableStream fetch bodies correctly per runtime — buffer to Blob in Bun (workaround for stream upload bugs), set `duplex: 'half'` in browsers and Node as required by the Fetch spec

- [#721](https://github.com/enboxorg/enbox/pull/721) [`fc923cb`](https://github.com/enboxorg/enbox/commit/fc923cb6a1f6d8e56f616a69d3e61345898d2cf9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(dwn-server): include CORS headers on per-IP rate-limit 429 responses so browsers can read the error instead of treating it as a CORS failure

  fix(agent): throttle sync engine remote requests to prevent rate-limit bursts — tree walk is now gated by a semaphore (max 4 concurrent remote requests) and pull concurrency reduced from 10 to 4

- Updated dependencies [[`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7)]:
  - @enbox/dwn-clients@0.2.1

## 0.5.0

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
  - @enbox/dwn-clients@0.2.0
  - @enbox/common@0.1.0
  - @enbox/crypto@0.1.0
  - @enbox/dwn-sdk-js@0.2.0
  - @enbox/dids@0.1.0

## 0.4.0

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

## 0.3.1

### Patch Changes

- [#658](https://github.com/enboxorg/enbox/pull/658) [`22d724e`](https://github.com/enboxorg/enbox/commit/22d724eb415b3eea71983ab6aecd5810efa8c6bc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix WalletConnect PAR request to send JSON instead of form-urlencoded

  The dwn-server's /connect/par endpoint parses the request body with
  req.json(), so sending application/x-www-form-urlencoded would fail
  with a JSON parse error.

## 0.3.0

### Minor Changes

- [#628](https://github.com/enboxorg/enbox/pull/628) [`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - BREAKING: Rename Web5-prefixed symbols to Enbox-prefixed across agent and dwn-clients

  - `Web5Agent` → `EnboxAgent`, `Web5UserAgent` → `EnboxUserAgent`, `Web5PlatformAgent` → `EnboxPlatformAgent`
  - `Web5RpcClient` → `EnboxRpcClient`, `Web5Rpc` → `EnboxRpc`, `HttpWeb5RpcClient` → `HttpEnboxRpcClient`, `WebSocketWeb5RpcClient` → `WebSocketEnboxRpcClient`
  - `Web5ConnectAuthRequest` → `EnboxConnectAuthRequest`, `Web5ConnectAuthResponse` → `EnboxConnectAuthResponse`
  - Deprecated aliases preserved for all renamed symbols
  - File renamed: `web5-user-agent.ts` → `enbox-user-agent.ts`
  - All downstream packages updated: @enbox/api, @enbox/auth

### Patch Changes

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

## 0.2.2

### Patch Changes

- Updated dependencies [[`7a68c55`](https://github.com/enboxorg/enbox/commit/7a68c5509da7d01700240b630ac529cbf94a629a)]:
  - @enbox/dwn-clients@0.0.9

## 0.2.1

### Patch Changes

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/common@0.0.6
  - @enbox/dids@0.0.8
  - @enbox/dwn-sdk-js@0.1.1
  - @enbox/dwn-clients@0.0.8
  - @enbox/crypto@0.0.7

## 0.2.0

### Minor Changes

- [#514](https://github.com/enboxorg/enbox/pull/514) [`0eb40d4`](https://github.com/enboxorg/enbox/commit/0eb40d4d111732262de01258c0f7f8c727466714) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: $squash protocol directive, live sync engine, record delivery, security hardening

  - dwn-sdk-js: add $squash protocol directive for RecordsWrite, record delivery and endpoint forwarding
  - agent: live sync engine with real-time subscriptions and connectivity awareness
  - api: live sync engine integration
  - common: escape LIKE wildcards, remove Math.random from public API
  - dids: add fetch timeouts and SSRF protection for did:web resolution
  - browser: add deactivatePolyfills, clearDrlCache, configurable resolvers, strict TypeScript mode
  - dwn-clients: properly signal rate limiting to clients
  - dwn-sql-store: add squash column migration and message store adjustments

### Patch Changes

- Updated dependencies [[`0eb40d4`](https://github.com/enboxorg/enbox/commit/0eb40d4d111732262de01258c0f7f8c727466714)]:
  - @enbox/dwn-sdk-js@0.1.0
  - @enbox/common@0.0.5
  - @enbox/dids@0.0.7
  - @enbox/dwn-clients@0.0.7
  - @enbox/crypto@0.0.6

## 0.1.9

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/dwn-clients@0.0.6
  - @enbox/common@0.0.4
  - @enbox/crypto@0.0.5
  - @enbox/dids@0.0.6
  - @enbox/dwn-sdk-js@0.0.8

## 0.1.8

### Patch Changes

- Updated dependencies [[`a111281`](https://github.com/enboxorg/enbox/commit/a111281ad3fb209680073154a95d97d26fc3edf8)]:
  - @enbox/dwn-clients@0.0.5

## 0.1.7

### Patch Changes

- [#261](https://github.com/enboxorg/enbox/pull/261) [`8a2f650`](https://github.com/enboxorg/enbox/commit/8a2f650c88f4b78f415dcacc23d7f4c82bc9a67b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(agent): preserve original error in sync catch blocks instead of generic 'unreachable'

## 0.1.6

### Patch Changes

- [#242](https://github.com/enboxorg/enbox/pull/242) [`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/dids@0.0.5
  - @enbox/dwn-sdk-js@0.0.7
  - @enbox/dwn-clients@0.0.4

## 0.1.5

### Patch Changes

- Updated dependencies [[`af2ba3a`](https://github.com/enboxorg/enbox/commit/af2ba3a7e9d5de44b40a38169e9296427a4f049b)]:
  - @enbox/crypto@0.0.4
  - @enbox/dids@0.0.4
  - @enbox/dwn-clients@0.0.3
  - @enbox/dwn-sdk-js@0.0.6

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
