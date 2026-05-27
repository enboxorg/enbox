# @enbox/agent

## 0.7.7

### Patch Changes

- [#952](https://github.com/enboxorg/enbox/pull/952) [`540babf`](https://github.com/enboxorg/enbox/commit/540babff775a2943ec9688027b95c1825c29c72b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a dedicated recovery-phrase restore path that preserves existing vault data when the phrase matches, rejects mismatched local vaults without replacing them, and exposes a wallet-friendly `restoreFromPhrase()` API. Remove the deprecated phrase import and local-connect aliases so vault recovery has one public API, while preserving delegate sync-scope repair inside the restore flow.

## 0.7.6

### Patch Changes

- Updated dependencies [[`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02)]:
  - @enbox/dwn-sdk-js@0.3.7
  - @enbox/dwn-clients@0.4.2

## 0.7.5

### Patch Changes

- [#947](https://github.com/enboxorg/enbox/pull/947) [`c1fefdb`](https://github.com/enboxorg/enbox/commit/c1fefdb1f8caec7a421ea4c2465d4d2c96a33f76) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix two sync engine issues:

  - **DID propagation retry**: When a newly created `did:dht` identity is hot-added to live sync, the remote DWN may not be able to resolve the DID yet (DHT propagation delay). `initializeLinkTarget` now retries with exponential backoff (2s, 4s, 8s) on DID resolution failures instead of giving up immediately.
  - **Push stream reuse**: Buffered push data is now sent as a `Blob` instead of a `ReadableStream`. `Blob` is replayable by `fetchWithRetry`, eliminating `ReadableStream is disturbed` errors on HTTP retry.

## 0.7.4

### Patch Changes

- [#945](https://github.com/enboxorg/enbox/pull/945) [`9a713ce`](https://github.com/enboxorg/enbox/commit/9a713ce549e1dfe07121baa6a2837abb9b0b71a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix three sync issues that caused cascading errors during identity creation and seed phrase recovery:

  - **Push retry for protocol dependencies**: Protocol dependency 400 errors (`ComposedProtocolNotInstalled`, `ProtocolNotFound`) are now classified as transient and retried instead of permanently dead-lettered. This makes out-of-order protocol pushes self-healing.
  - **Push stream buffering**: `pushMessages()` now buffers data streams before sending, preventing `ReadableStream is disturbed` errors when the underlying HTTP fetch retries.
  - **Recovery KeyDeliveryProtocol**: `recoverIdentitiesFromRemote()` installs the KeyDeliveryProtocol for the agent DID before the first sync pull, so encrypted JwkProtocol records (private keys) can be committed by the closure resolver.

## 0.7.3

### Patch Changes

- [#941](https://github.com/enboxorg/enbox/pull/941) [`e58dd0a`](https://github.com/enboxorg/enbox/commit/e58dd0a517fe1fbb6c8e7c862904493b02353293) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Install KeyDeliveryProtocol proactively when a protocol with `encryptionRequired: true` is first installed, rather than lazily on the first encrypted write. This fixes a race condition where the sync engine's closure resolver couldn't find the dependency because the DWN event fired before `postWriteKeyDelivery` completed, and a recovery issue where encrypted JWK records couldn't be pulled on a fresh device.

## 0.7.2

### Patch Changes

- [#937](https://github.com/enboxorg/enbox/pull/937) [`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Register agent DID for sync in vault connect and import-from-phrase flows to enable seed phrase recovery. Rename `localConnect` to `vaultConnect` and `LocalConnectOptions` to `VaultConnectOptions` (old names preserved as deprecated aliases). Export `IdentityProtocolDefinition` and `JwkProtocolDefinition` from `@enbox/agent`.

## 0.7.1

### Patch Changes

- [#913](https://github.com/enboxorg/enbox/pull/913) [`400c70a`](https://github.com/enboxorg/enbox/commit/400c70ac2e7ed82a0adad86f3688e682f488bd62) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf(connect): single-flight DID resolver + connect.perf timing instrumentation

  - `@enbox/dids`: `UniversalResolver.resolve` now coalesces concurrent
    no-options resolutions of the same DID via an in-flight map. Without this, parallel
    callers (e.g. the wallet's `Promise.all`-fanned `prepareProtocol` calls)
    each issued an independent BEP44 lookup against the `did:dht` relay,
    multiplying wall-time by N and saturating per-host browser connection
    limits. A second concurrent resolution for the same DID now awaits the
    first instead of starting its own. Calls that pass per-resolution options
    still resolve independently so method-specific options cannot be mixed.

  - `@enbox/agent`: `submitConnectResponse` now emits `[connect.perf]`
    timing logs around the wallet-side critical path (delegate DID creation,
    permission grant fan-out, revocation grant creation/fan-out, response
    signing/encryption, callback POST, total) so operators can bisect remaining
    wall-time directly from wallet debug logs.

  - `@enbox/common`: add reusable `nowMs()` and `timed()` helpers for
    monotonic elapsed-duration measurement and success/failure timing logs.
    `sleep()` now explicitly clamps negative durations to `0`, matching its
    documented behavior without relying on runtime timeout coercion.

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
  - @enbox/dids@0.1.1
  - @enbox/common@0.1.1
  - @enbox/dwn-clients@0.4.1
  - @enbox/dwn-sdk-js@0.3.6
  - @enbox/crypto@0.1.1

## 0.7.0

### Minor Changes

- [#914](https://github.com/enboxorg/enbox/pull/914) [`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf(connect): eliminate redundant remote ProtocolsConfigure send and cap per-request budget in the wallet "Authorizing…" hot path

  Two fixes that together remove the dominant tail-latency in `submitConnectResponse`:

  1. **`@enbox/agent` — `prepareProtocol` no longer issues a redundant remote send when the protocol is already installed locally.** The wallet's own `prepareProtocol` (in `@enbox/web-wallet`) runs _before_ `submitConnectResponse` and is the canonical place that fans the protocol out to every owner DWN endpoint in parallel. The agent only needs to verify the protocol is installed locally so it can sign / encrypt grants for it. The "exists locally" branch now performs a single local `ProtocolsQuery` and returns — turning the previous sequential per-endpoint legacy `agent.sendDwnRequest` (which could burn the underlying HTTP client's 4×30 s retry budget on a single unhealthy endpoint, _per protocol_) into a ~10 ms local DB read. The "missing locally" safety-fallback branch now configures the protocol locally via `processDwnRequest` and then fans out to every endpoint in parallel using the existing `mapConcurrentSettled` + `CONNECT_FANOUT_CONCURRENCY` primitive (best-effort — sync delivers any missed copies eventually).

  2. **`@enbox/dwn-clients` — `DwnRpcRequest` now accepts an optional `signal: AbortSignal`, plumbed through `HttpDwnRpcClient.sendDwnRequest` / `fetchWithRetry` via `AbortSignal.any([caller, perAttemptTimeout])`.** Aborting short-circuits the retry loop (`AbortError` is non-retryable). The connect flow uses this with a 10 s per-request budget on every connect-flow `agent.rpc.sendDwnRequest` (configure fan-out + permission grants + revocation grants) so a single unhealthy DWN endpoint can no longer stall the user-visible "Authorizing…" spinner for minutes.

  Test coverage:

  - `packages/agent/tests/connect.spec.ts` — wall-clock parallelism assertion, AbortSignal presence assertion, and a "one endpoint hangs forever" scenario whose end-to-end completes well under the per-request budget.
  - `packages/dwn-clients/tests/http-dwn-rpc-client.spec.ts` — caller signal is plumbed to fetch and abort short-circuits the retry loop on the very first attempt.
  - All existing `connect.spec.ts` assertions for `prepareProtocol` updated to match the new "skip redundant remote send when local" + "parallel fan-out via RPC client when missing locally" shape.

### Patch Changes

- Updated dependencies [[`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999)]:
  - @enbox/dwn-clients@0.4.0

## 0.6.8

### Patch Changes

- [`55f20c8`](https://github.com/enboxorg/enbox/commit/55f20c83218b97f5091aad8d450bfc32e8958c77) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf(connect): parallelize endpoint fan-out with bounded concurrency in `createPermissionGrants` and the revocation-grant loop in `submitConnectResponse`

  Both loops were previously sequential per DWN endpoint, which made the wallet's "Authorizing..." spinner wall-time scale linearly with `(grants × endpoints)`. With multiple permissions and multiple DWN endpoints under network load this dominated the connect flow latency, leaving the user stuck on "Authorizing..." for many seconds before the PIN was shown.

  To get the latency win without a thundering-herd risk when either dimension grows large, the agent now uses a small reusable bounded-concurrency primitive — `mapConcurrent` / `mapConcurrentSettled` — exported from `@enbox/agent/utils`. `(grant, endpoint)` tuples are flattened into a single send queue and dispatched through a sliding-window worker pool capped by `CONNECT_FANOUT_CONCURRENCY` (defaults to 8). This protects DWN servers and the browser connection pool from being saturated by a request with many permissions or a tenant with many DWNs, while still hiding endpoint latency.

  `createPermissionGrants` retains the "at least one endpoint success per grant" guarantee. `submitConnectResponse`'s revocation-grant fan-out remains best-effort (sync delivers eventually); individual failures are swallowed.

## 0.6.7

### Patch Changes

- Updated dependencies [[`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0)]:
  - @enbox/dwn-sdk-js@0.3.5
  - @enbox/dwn-clients@0.3.3

## 0.6.6

### Patch Changes

- [#900](https://github.com/enboxorg/enbox/pull/900) [`1240bb1`](https://github.com/enboxorg/enbox/commit/1240bb167ffedc051f5a1e4beb08463080d18ae0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(agent): drain in-flight eager contextKey sends before agent teardown so tests don't surface LEVEL_DATABASE_NOT_OPEN or 'Agent DID is not set' as unhandled errors between tests

- [#871](https://github.com/enboxorg/enbox/pull/871) [`b35f5cb`](https://github.com/enboxorg/enbox/commit/b35f5cb8eb726dd26bcb83b2082d3190a83a36f7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf: eliminate startup and reload bottlenecks

  - Cache vault `getDid()` result (avoids JWE decrypt + BearerDid.import on every call)
  - Eliminate duplicate X25519 context key derivation in `postWriteKeyDelivery()`
  - Parallelize grant processing, vault encryptions, storage writes, and post-write operations
  - Cache sync targets with 30s TTL (avoids DID resolution on every sync tick)
  - Cache `encryptionRequired` / `hasEncryptedTypes` at construction time
  - Replace protocol init TtlCache with permanent Set
  - Skip unnecessary `lock()` in `unlock()` when already locked

## 0.6.5

### Patch Changes

- Updated dependencies [[`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d)]:
  - @enbox/dwn-sdk-js@0.3.4
  - @enbox/dwn-clients@0.3.2

## 0.6.4

### Patch Changes

- [#860](https://github.com/enboxorg/enbox/pull/860) [`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish delegateKeyDelivery schema and cross-device key delivery

  The delegateKeyDelivery field was added to the PermissionGrantData JSON
  schema and the agent's connect protocol in commit 2887165, but was not
  included in a subsequent publish. This caused a version mismatch where
  @enbox/agent@0.6.3 generates grants with delegateKeyDelivery but
  @enbox/dwn-sdk-js@0.3.2 rejects them with SchemaValidationAdditionalPropertyNotAllowed.

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/dwn-sdk-js@0.3.3
  - @enbox/dwn-clients@0.3.1

## 0.6.3

### Patch Changes

- [#854](https://github.com/enboxorg/enbox/pull/854) [`57b1b52`](https://github.com/enboxorg/enbox/commit/57b1b52dcf80f2a4e995d649bb64c9e0b9eac9d8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: delegate encrypted write fails with 'Unable to get signer for author did:dht'

  When a delegate writes to a protocol type with `encryptionRequired: true`, the write
  failed because: (1) the delegate's local protocol definition lacked the owner's
  `$encryption` keys needed for ProtocolPath encryption, (2) the internal protocol
  definition lookup signed the ProtocolsQuery as the owner DID whose private key is
  not available to the delegate, and (3) the protocol definition cache was not populated
  after the delegate installed the owner's remote definition.

  The delegate now fetches the owner's protocol definition (with `$encryption` keys)
  from the remote DWN during auto-configure, resolves a ProtocolsQuery permission grant
  for local lookups, and caches the definition after installation. If the remote
  definition cannot be fetched for a protocol with encrypted types, the operation fails
  loudly instead of silently downgrading security.

## 0.6.2

### Patch Changes

- [#850](https://github.com/enboxorg/enbox/pull/850) [`140bd84`](https://github.com/enboxorg/enbox/commit/140bd8474d0a333fe0b5428e1835d8176d269293) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: encrypt delegate decryption keys at rest using the vault CEK

  Delegate decryption keys (DelegateDecryptionKey[] and DelegateContextKey[])
  were previously stored as plaintext JSON in localStorage, making them
  accessible to any XSS attack on the dapp origin. These keys contain
  HD-derived X25519 private key material capable of decrypting all
  protocol-encrypted records within the granted scope.

  Keys are now encrypted as compact JWE (AES-256-GCM with the vault's
  content encryption key) before persisting to storage. On session restore,
  they are decrypted after the vault is unlocked. Backward-compatible with
  sessions that stored keys as plaintext JSON (detected via JWE format check).

  Added IdentityVault.encryptData/decryptData interface methods and
  HdIdentityVault implementation.

- [#853](https://github.com/enboxorg/enbox/pull/853) [`928f72f`](https://github.com/enboxorg/enbox/commit/928f72fb81beb7a979908e323ebe6510358b31b6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: install key-delivery protocol on delegate's local DWN during connect

  The sync engine's closure validator requires the key-delivery protocol to be
  installed locally for any encrypted protocol. Without it, sync links for
  encrypted records transition to `repairing` state with
  ClosureEncryptionDependencyMissing warnings. The key-delivery protocol is now
  installed on the delegate's local DWN during importDelegateAndSetupSync.

  Also exports KeyDeliveryProtocolDefinition from @enbox/agent.

## 0.6.1

### Patch Changes

- [#840](https://github.com/enboxorg/enbox/pull/840) [`d3ae193`](https://github.com/enboxorg/enbox/commit/d3ae193f546443e0a3ceb059cd721aaae2844ae3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: delegate encrypted write fails with 'Unable to get signer for author did:dht'

  When a delegate writes to a protocol type with `encryptionRequired: true`, the write
  failed because: (1) the delegate's local protocol definition lacked the owner's
  `$encryption` keys needed for ProtocolPath encryption, (2) the internal protocol
  definition lookup signed the ProtocolsQuery as the owner DID whose private key is
  not available to the delegate, and (3) the protocol definition cache was not populated
  after the delegate installed the owner's remote definition.

  The delegate now fetches the owner's protocol definition (with `$encryption` keys)
  from the remote DWN during auto-configure, resolves a ProtocolsQuery permission grant
  for local lookups, and caches the definition after installation. If the remote
  definition cannot be fetched for a protocol with encrypted types, the operation fails
  loudly instead of silently downgrading security.

## 0.6.0

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

- [#812](https://github.com/enboxorg/enbox/pull/812) [`28fd8ed`](https://github.com/enboxorg/enbox/commit/28fd8ed952df6ea032f246180370169758a1b0f8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: dead letter tracking and sync health API

  Adds durable tracking of permanently failed sync messages in a LevelDB
  sublevel. Failed messages are no longer logged and forgotten — they persist
  until explicitly cleared by the application.

  New public API on SyncEngine:

  - `getFailedMessages(tenantDid?)` — list all dead letter entries
  - `clearFailedMessage(messageCid)` — remove a single entry
  - `clearAllFailedMessages(tenantDid?)` — clear all or scoped to a tenant
  - `getSyncHealth()` — summary with connectivity, failed count, degraded links

  Push permanent failures (400/401/403) now carry structured diagnostic info
  (`PermanentPushFailure` type with `statusCode` and `detail`) and are
  automatically recorded in the dead letter store.

### Patch Changes

- [#813](https://github.com/enboxorg/enbox/pull/813) [`963d366`](https://github.com/enboxorg/enbox/commit/963d366de71e9e6c077e0ed1ad11904e8a587c92) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: complete dead letter wiring for all sync failure paths

  Records permanently failed messages in the dead letter store at every
  failure point, not just push-permanent (400/401/403):

  - push retry exhaustion: all CIDs in the batch recorded as `push-exhausted`
  - pull processing failures: CIDs that fail after 3 retry passes recorded
    as `pull-processing` (pullMessages now returns failed CIDs)
  - closure validation failures: the triggering message CID recorded as
    `closure` with the ClosureFailureCode and detail
  - live pull processRawMessage exceptions: the failing CID recorded as
    `pull-processing` with the error message

- Updated dependencies [[`f7b4c79`](https://github.com/enboxorg/enbox/commit/f7b4c79f5a11a4d3de7836bb1ee56e47c90faf3b)]:
  - @enbox/dwn-clients@0.3.0

## 0.5.16

### Patch Changes

- [#806](https://github.com/enboxorg/enbox/pull/806) [`1c567c0`](https://github.com/enboxorg/enbox/commit/1c567c008e60738e7fbbba5f511cf201c96f183e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: exempt built-in permissions protocol from sync closure validation

  The permissions protocol (`https://identity.foundation/dwn/permissions`)
  is a core protocol handled natively by every DWN — it never has a
  `ProtocolsConfigure` message. The closure resolver was requiring one for
  permission grant records, causing `ClosureProtocolMetadataMissing`
  failures and cascading `ProtocolAuthorizationProtocolNotFound` errors
  during delegated connect flows.

## 0.5.15

### Patch Changes

- [#804](https://github.com/enboxorg/enbox/pull/804) [`98eb9be`](https://github.com/enboxorg/enbox/commit/98eb9be0c616da886db5d43e3186874e050d44c2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: add delete to default connect permissions and quiet singleton push warnings

  Adds `'delete'` to `DEFAULT_PERMISSIONS` in `@enbox/auth` so apps using
  bare protocol definitions in `auth.connect()` get `Records.Delete` grants
  by default. Downgrades `RecordLimitExceeded` sync push warnings to debug
  level in `@enbox/agent` — these are expected in multi-device singleton
  convergence scenarios.

## 0.5.14

### Patch Changes

- [#801](https://github.com/enboxorg/enbox/pull/801) [`6b77eee`](https://github.com/enboxorg/enbox/commit/6b77eeed4d0ae4b99b14631b41eb7ebaf0dd9587) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: strip encodedData from live pull events before DWN processing, parallelize sync targets, and immediate-first push debounce

  - Fix live WebSocket sync delivery: `extractDataStream()` now deletes the transport-level `encodedData` field after extracting inline data, preventing the DWN schema validator from rejecting every `RecordsWrite` received via subscription.
  - Parallelize sync targets: `sync()` reconciles URL groups concurrently; `startLiveSync()` initializes all replication links concurrently. Partial failure keeps the agent online if at least one remote succeeds.
  - Immediate-first push debounce: the first write in a quiet window triggers an immediate push (~0ms latency). Burst writes batch via a short 100ms drain timer.

## 0.5.13

### Patch Changes

- [#792](https://github.com/enboxorg/enbox/pull/792) [`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: prevent empty messageCid in ProgressToken across EventLog and sync engine

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/dwn-sdk-js@0.3.2
  - @enbox/dwn-clients@0.2.6

## 0.5.12

### Patch Changes

- [#789](https://github.com/enboxorg/enbox/pull/789) [`43d805e`](https://github.com/enboxorg/enbox/commit/43d805e51b63c358f1c9c1a51623d0c5f44446fe) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: don't retry permanent push failures (400/401/403)

  Prevents infinite retry loop for protocol-scoped singleton records
  (profile, avatar, hero, wallet) that get 400 RecordLimitExceeded from
  the remote. PushResult now distinguishes transient vs permanent failures.

## 0.5.11

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
  - @enbox/dwn-clients@0.2.5

## 0.5.10

### Patch Changes

- [#762](https://github.com/enboxorg/enbox/pull/762) [`3199425`](https://github.com/enboxorg/enbox/commit/319942541442670d8f1fd203adc522781d3cee72) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(agent): sync engine audit cleanup — cursor safety, push retry, dead code removal

  1. Live pull cursor only advances on successful processRawMessage.
     Previously the cursor advanced even when processing failed,
     permanently losing the event.

  2. Failed push CIDs are re-queued for retry on the next debounce
     cycle (1s backoff). Previously they were permanently lost until
     the SMT integrity check.

  3. Removed ~180 lines of dead code: walkTreeDiff, Semaphore,
     getRemoteSubtreeHash, getRemoteLeaves, REMOTE_CONCURRENCY.
     These were replaced by the batched diff mechanism.

  4. Simplified openLivePullSubscription grant lookup — removed
     redundant try/catch fallback (unified scope matching handles it).

  5. Fixed openLocalPushSubscription to request MessagesSubscribe
     grant instead of MessagesRead (semantically correct).

  6. Cached getSyncPermissionGrantId result in diffWithRemote to
     avoid redundant lookup.

  7. flushPendingPushes now pushes to all endpoints in parallel
     instead of sequentially.

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
