# @enbox/dwn-clients

## 0.4.2

### Patch Changes

- Updated dependencies [[`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02)]:
  - @enbox/dwn-sdk-js@0.3.7

## 0.4.1

### Patch Changes

- [#928](https://github.com/enboxorg/enbox/pull/928) [`03899ca`](https://github.com/enboxorg/enbox/commit/03899ca7d20ad48b874f7e6253381f19cd7c3480) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add shared agent sessions and high-level Enbox connection helpers.

  **New surface in `@enbox/agent`:**

  - `AgentSession` class plus the `AgentSessionPrimitives` base, so the minimal `{ agent, did, delegateDid? }` session shape lives in one place. `AgentSessionPrimitives.agent` is typed as `EnboxPlatformAgent` (vault, sync, and secrets are part of every real session) so downstream consumers don't need a `hasSync`-style type guard.

  **New surface in `@enbox/api`:**

  - `Enbox.fromSession(session)` — synchronous, accepts any session-shaped object (including `AuthSession` and custom shapes).
  - `Enbox.connect(options?)` — asynchronous, creates an `AuthManager`, runs `auth.connect()`, and returns `{ auth, enbox, session }`. Owns the `AuthManager` lifecycle when it built the agent/storage itself: a single `await enbox.disconnect()` tears down vault + storage + sync. When the caller supplies a pre-built `agent` or `storage`, Enbox keeps its hands off the caller-owned resources.
  - For raw `{ agent, connectedDid }` access, use `new Enbox(params)` (the public constructor).
  - `Enbox.connect()` previously returned `Enbox` synchronously; it now returns `Promise<{ auth, enbox, session }>`. Existing callers that did `const enbox = Enbox.connect({ session })` should migrate to `const enbox = Enbox.fromSession(session)`, and `const enbox = Enbox.connect({ agent, connectedDid })` should migrate to `new Enbox({ agent, connectedDid })`.
  - Concurrency guard: two parallel `Enbox.connect()` invocations against the same `dataPath` reject the second with a clear domain-level error instead of racing on the LevelDB lock.
  - `enbox.disconnect()` is memoized — parallel calls share one teardown promise so `agent.sync.stopSync()` (and the optional `auth.shutdown()`) run exactly once.
  - `auth.shutdown()` failures during error recovery are surfaced via `console.warn` while the original `connect` error still propagates.

  **New surface in `@enbox/auth`:**

  - `AuthSession` is now an alias for `AgentSession` from `@enbox/agent` (`export { AgentSession as AuthSession } from '@enbox/agent'`). The constructor contract is unchanged; `instanceof` checks succeed against both names.
  - `IdentityInfo` is a `@deprecated` alias for `AgentSessionIdentity`.
  - `HandlerConnectOptions.password?` accepts a per-call password override (previously silently dropped).
  - The auth-manager exposes the `@enbox/auth/auth-manager` subpath; it's marked `@internal` and is intended for monorepo use only.
  - `_handlerConnect` now resolves the connect handler **before** initializing the vault, so a misconfigured handler-flow call cannot leak an initialized vault to disk.
  - `_isLocalConnect` rewritten as a TypeScript type-guard using positive narrowing: presence of a non-empty `protocols` array OR a non-null `connectHandler` selects the handler flow; everything else (including the no-options case, an empty `protocols: []`, and `null` handler/protocols from JS callers) routes to local. Handler signals now win over local-style defaults (`password`, `dwnEndpoints`, `metadata`, `createIdentity`, `recoveryPhrase`) when both are present.
  - All `connect` / `restoreSession` / `connectHeadless` entry points guard against re-use after `shutdown()` and throw a clear domain error rather than failing deep in sync/storage internals.
  - The "no password set" security warning now also fires when an explicit empty-string password is supplied.

  **New surface in `@enbox/common`:**

  - `omitUndefined<T>(input)` — immutable, shallow, typed companion to `removeUndefinedProperties` (which remains mutating and recursive). Use the variant that matches the call site.
  - `concatenateUrl(baseUrl, path)` — joins a base URL and a path with exactly one slash between them. Previously duplicated verbatim in `@enbox/agent/utils.ts` and `@enbox/dwn-clients/utils.ts`; both copies now removed.
  - `sleep(durationInMilliseconds)` — promise-based sleep primitive that replaces 7 inline `new Promise(resolve => setTimeout(resolve, ms))` patterns across `@enbox/agent`, `@enbox/dwn-clients`, `@enbox/dwn-sdk-js`, `@enbox/dwn-server`, and `@enbox/electrobun-dwn`. `Time.sleep` in `@enbox/dwn-sdk-js` is now a one-line delegate to this primitive, preserving the public `Time` API.
  - `@enbox/common` is now the single source of truth for object-shape helpers across the monorepo. The 15 source files in `@enbox/dwn-sdk-js` that used `isEmptyObject` / `removeEmptyObjects` / `removeUndefinedProperties` now import directly from `@enbox/common` (the previous re-export stub at `@enbox/dwn-sdk-js/src/utils/object.ts` is deleted). `isEmptyObject(null)` and the recursive helpers no longer throw `TypeError` on `null` — a latent crash that no DWN code path was hitting in practice.
  - `SyncEngineLevel.stopSync()` coerces non-finite (`NaN`, `Infinity`) timeouts to the 2000 ms default so a computed-NaN argument can't spin the poll loop.

  **`@enbox/dwn-clients`:**

  - `concatenateUrl` is no longer re-exported from `@enbox/dwn-clients` (and the `./utils.js` subpath is removed). Import from `@enbox/common` instead. Internal callers (`@enbox/agent`'s `enbox-connect-protocol.ts` and `@enbox/dwn-clients`'s own `dwn-registrar.ts`) have already been migrated.

  **`@enbox/browser`** re-exports the new `EnboxSession*` / `EnboxConnect*` types so dapps don't have to reach into `@enbox/api` for explicit annotations.

- Updated dependencies [[`400c70a`](https://github.com/enboxorg/enbox/commit/400c70ac2e7ed82a0adad86f3688e682f488bd62), [`03899ca`](https://github.com/enboxorg/enbox/commit/03899ca7d20ad48b874f7e6253381f19cd7c3480), [`3dcfbcb`](https://github.com/enboxorg/enbox/commit/3dcfbcbf836d4cf85d5c7c23801ee13d1b7ba978)]:
  - @enbox/common@0.1.1
  - @enbox/dwn-sdk-js@0.3.6
  - @enbox/crypto@0.1.1

## 0.4.0

### Minor Changes

- [#914](https://github.com/enboxorg/enbox/pull/914) [`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf(connect): eliminate redundant remote ProtocolsConfigure send and cap per-request budget in the wallet "Authorizing…" hot path

  Two fixes that together remove the dominant tail-latency in `submitConnectResponse`:

  1. **`@enbox/agent` — `prepareProtocol` no longer issues a redundant remote send when the protocol is already installed locally.** The wallet's own `prepareProtocol` (in `@enbox/web-wallet`) runs _before_ `submitConnectResponse` and is the canonical place that fans the protocol out to every owner DWN endpoint in parallel. The agent only needs to verify the protocol is installed locally so it can sign / encrypt grants for it. The "exists locally" branch now performs a single local `ProtocolsQuery` and returns — turning the previous sequential per-endpoint legacy `agent.sendDwnRequest` (which could burn the underlying HTTP client's 4×30 s retry budget on a single unhealthy endpoint, _per protocol_) into a ~10 ms local DB read. The "missing locally" safety-fallback branch now configures the protocol locally via `processDwnRequest` and then fans out to every endpoint in parallel using the existing `mapConcurrentSettled` + `CONNECT_FANOUT_CONCURRENCY` primitive (best-effort — sync delivers any missed copies eventually).

  2. **`@enbox/dwn-clients` — `DwnRpcRequest` now accepts an optional `signal: AbortSignal`, plumbed through `HttpDwnRpcClient.sendDwnRequest` / `fetchWithRetry` via `AbortSignal.any([caller, perAttemptTimeout])`.** Aborting short-circuits the retry loop (`AbortError` is non-retryable). The connect flow uses this with a 10 s per-request budget on every connect-flow `agent.rpc.sendDwnRequest` (configure fan-out + permission grants + revocation grants) so a single unhealthy DWN endpoint can no longer stall the user-visible "Authorizing…" spinner for minutes.

  Test coverage:

  - `packages/agent/tests/connect.spec.ts` — wall-clock parallelism assertion, AbortSignal presence assertion, and a "one endpoint hangs forever" scenario whose end-to-end completes well under the per-request budget.
  - `packages/dwn-clients/tests/http-dwn-rpc-client.spec.ts` — caller signal is plumbed to fetch and abort short-circuits the retry loop on the very first attempt.
  - All existing `connect.spec.ts` assertions for `prepareProtocol` updated to match the new "skip redundant remote send when local" + "parallel fan-out via RPC client when missing locally" shape.

## 0.3.3

### Patch Changes

- Updated dependencies [[`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0)]:
  - @enbox/dwn-sdk-js@0.3.5

## 0.3.2

### Patch Changes

- Updated dependencies [[`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d)]:
  - @enbox/dwn-sdk-js@0.3.4

## 0.3.1

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/dwn-sdk-js@0.3.3

## 0.3.0

### Minor Changes

- [#809](https://github.com/enboxorg/enbox/pull/809) [`f7b4c79`](https://github.com/enboxorg/enbox/commit/f7b4c79f5a11a4d3de7836bb1ee56e47c90faf3b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: browser connectivity detection, WebSocket heartbeat, and rpc.ping server handler

  Adds browser `online`/`offline` and `visibilitychange` event listeners to the
  sync engine. On offline, all active per-link connectivity states transition to
  offline (reflected by the public `connectivityState` getter). On online or page
  becoming visible, an immediate SMT reconciliation runs. Safe no-op in Node.

  Adds application-level heartbeat (ping/pong) to `JsonRpcSocket` — sends
  `rpc.ping` every 30s and closes the connection if no response arrives within
  10s. Detects silently dead WebSocket connections that TCP keepalive misses.

  Adds `rpc.ping` handler to the DWN server and a defensive unknown-method
  guard to `JsonRpcRouter.handle()` (returns MethodNotFound instead of crashing).

## 0.2.6

### Patch Changes

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/dwn-sdk-js@0.3.2

## 0.2.5

### Patch Changes

- [`5818860`](https://github.com/enboxorg/enbox/commit/5818860e2bca5201ff368d4748393efb1544d7a2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: causal scoped replication for multi-master DWN sync

  Redesigns DWN sync as a causal, scoped, multi-master replication system.

  dwn-sdk-js:

  - ProgressToken replaces opaque string cursor ({ streamId, epoch, position, messageCid })
  - EventLog interface: emit() returns ProgressToken, getReplayBounds() for gap metadata
  - ProgressGap detection with 410 status and structured metadata
  - EventEmitterEventLog: epoch generation, streamId derivation, cursor validation
  - MessagesFilter: protocolPathPrefix and contextIdPrefix with range filter conversion
  - ProtocolsConfigure shadow filter for prefix-scoped subscriptions
  - JSON schemas updated for ProgressToken and prefix filter fields

  dwn-clients:

  - ResubscribeFactory, createJsonRpcAck, TrackedSubscription use ProgressToken
  - WebSocket client handles ProgressToken events and acks

  dwn-server:

  - FlowController: ProgressToken matching with streamId/epoch domain validation
  - NatsEventLog: ProgressToken emit/read/subscribe, getReplayBounds, cursor validation
  - Subscription ack handler validates ProgressToken object shape

  agent:

  - ReplicationLedger: per-link durable state with CRUD and checkpoint helpers
  - Delivery-order tracking: ordinal-based pull progression handling concurrent completion
  - Closure resolver: 6 dependency classes with BFS traversal, caching, depth limits
  - Causal grant ordering: temporal validity at closure root commit point
  - Gap detection triggers repair; repair with retry scheduling and degraded_poll fallback
  - Echo-loop suppression scoped per remote endpoint
  - Subset scope prefix filtering (agent-side + SDK-level)
  - Per-link connectivity state with aggregate getter
  - Observability events: 9 typed event kinds at all state transitions
  - Squash convergence handled by DWN SDK built-in performRecordsSquash

- Updated dependencies [[`5818860`](https://github.com/enboxorg/enbox/commit/5818860e2bca5201ff368d4748393efb1544d7a2)]:
  - @enbox/dwn-sdk-js@0.3.1

## 0.2.4

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/dwn-sdk-js@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1

## 0.2.1

### Patch Changes

- [#719](https://github.com/enboxorg/enbox/pull/719) [`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7) Thanks [@csuwildcat](https://github.com/csuwildcat)! - fix(agent): prefer locally-stored BearerDid for signing, avoiding unnecessary DID resolution round-trips that can fail on malformed cached data

  fix(dwn-clients): handle ReadableStream fetch bodies correctly per runtime — buffer to Blob in Bun (workaround for stream upload bugs), set `duplex: 'half'` in browsers and Node as required by the Fetch spec

## 0.2.0

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
  - @enbox/common@0.1.0
  - @enbox/crypto@0.1.0
  - @enbox/dwn-sdk-js@0.2.0

## 0.1.0

### Minor Changes

- [#628](https://github.com/enboxorg/enbox/pull/628) [`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - BREAKING: Rename Web5-prefixed symbols to Enbox-prefixed across agent and dwn-clients

  - `Web5Agent` → `EnboxAgent`, `Web5UserAgent` → `EnboxUserAgent`, `Web5PlatformAgent` → `EnboxPlatformAgent`
  - `Web5RpcClient` → `EnboxRpcClient`, `Web5Rpc` → `EnboxRpc`, `HttpWeb5RpcClient` → `HttpEnboxRpcClient`, `WebSocketWeb5RpcClient` → `WebSocketEnboxRpcClient`
  - `Web5ConnectAuthRequest` → `EnboxConnectAuthRequest`, `Web5ConnectAuthResponse` → `EnboxConnectAuthResponse`
  - Deprecated aliases preserved for all renamed symbols
  - File renamed: `web5-user-agent.ts` → `enbox-user-agent.ts`
  - All downstream packages updated: @enbox/api, @enbox/auth

### Patch Changes

- Updated dependencies [[`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/common@0.0.7
  - @enbox/crypto@0.0.8
  - @enbox/dwn-sdk-js@0.1.2

## 0.0.9

### Patch Changes

- [#553](https://github.com/enboxorg/enbox/pull/553) [`7a68c55`](https://github.com/enboxorg/enbox/commit/7a68c5509da7d01700240b630ac529cbf94a629a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: include providerAuth and maxInFlight in getServerInfo response

  `HttpDwnRpcClient.getServerInfo()` explicitly mapped fields from the `/info` JSON response but omitted `providerAuth` and `maxInFlight`, causing provider-auth-v0 registration to silently fall through to the PoW path.

## 0.0.8

### Patch Changes

- [#539](https://github.com/enboxorg/enbox/pull/539) [`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish unpublished fixes across packages

  - `@enbox/common`: `open()` in KeyValueStore interface
  - `@enbox/dids`: `DidResolverCacheMemory`, resolver lifecycle management
  - `@enbox/dwn-sdk-js`: `DidResolverCacheMemory` default in `Dwn.create()` (fixes "Database is not open" in containers)
  - `@enbox/dwn-clients`: `DwnServerInfoCacheMemory`
  - `@enbox/dwn-server`: Actor delivery, noop resolver cache, registration gate fix

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/common@0.0.6
  - @enbox/dwn-sdk-js@0.1.1
  - @enbox/crypto@0.0.7

## 0.0.7

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
  - @enbox/common@0.0.5
  - @enbox/crypto@0.0.6

## 0.0.6

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/common@0.0.4
  - @enbox/crypto@0.0.5
  - @enbox/dwn-sdk-js@0.0.8

## 0.0.5

### Patch Changes

- [#267](https://github.com/enboxorg/enbox/pull/267) [`a111281`](https://github.com/enboxorg/enbox/commit/a111281ad3fb209680073154a95d97d26fc3edf8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: add `duplex: 'half'` to streaming fetch requests for browser compatibility

  Browsers require `duplex: 'half'` in the `RequestInit` options when the request
  body is a `ReadableStream`. Without it, the sync-push path (which sends record
  data as a raw stream) fails with:
  "The `duplex` member must be specified for a request with a streaming body".

## 0.0.4

### Patch Changes

- [#242](https://github.com/enboxorg/enbox/pull/242) [`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/dwn-sdk-js@0.0.7

## 0.0.3

### Patch Changes

- Updated dependencies [[`af2ba3a`](https://github.com/enboxorg/enbox/commit/af2ba3a7e9d5de44b40a38169e9296427a4f049b)]:
  - @enbox/crypto@0.0.4
  - @enbox/dwn-sdk-js@0.0.6

## 0.0.2

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.0.5
