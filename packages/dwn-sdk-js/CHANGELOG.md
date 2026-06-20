# @enbox/dwn-sdk-js

## 0.4.1

### Patch Changes

- [#1009](https://github.com/enboxorg/enbox/pull/1009) [`970aa97`](https://github.com/enboxorg/enbox/commit/970aa972013c61d9acc6a077f2f5ec2ae72ebf54) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: convergent tombstones — delete-wins over writes and a canonical-winner lattice among competing deletes. A RecordsDelete now displaces a RecordsWrite regardless of timestamp (the convergent counterpart of the write handler's writes-after-delete rejection), and competing tombstones resolve to one canonical winner on every replica: a prune beats a plain delete regardless of timestamp, and within the same class the newest (messageTimestamp, then CID) wins. Supersession displacement is decided by CID membership rather than timestamp comparison so the retained message survives resumable-task replay. Public behavior change: deleting an already-deleted record now returns 202 when the incoming tombstone wins and 409 Conflict when it is beaten (replication classifies the 409 as a Superseded no-op); 404 is returned only when the record has no messages at all. `Records.canPerformDeleteAgainstRecord` is removed in favor of the shared `Records.isDeleteBeatenByExistingTombstone` predicate used by both admission and resumable-task replay.

- [#1014](https://github.com/enboxorg/enbox/pull/1014) [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add durable message-store progress positions and replication feed primitives, preserve same-CID index/data-completion transitions, fail fast on pre-substrate Level/IndexedDB layouts, and remove obsolete DWN record upgrade code.

- [#1011](https://github.com/enboxorg/enbox/pull/1011) [`211049b`](https://github.com/enboxorg/enbox/commit/211049bd7727c80b701e8d6be243a5c464b8bc81) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: emit all missing ancestor refs in one Incomplete

  `applyReplicatedMessage` now layer-batches missing-ancestor dependencies: the incoming message's `contextId` is split into its recordId segments, each segment above the failure-named ancestor is presence-checked against the message store, and a single `Incomplete` names every locally-absent ancestor — for both the immediate-parent referential failure and record-chain construction failure — instead of surfacing one ancestry level per retry pass. Deep record chains now resolve in a bounded number of passes regardless of depth. Refs remain recordId selectors and the wire shape is unchanged.

- [#1015](https://github.com/enboxorg/enbox/pull/1015) [`5c1e8dc`](https://github.com/enboxorg/enbox/commit/5c1e8dc6bdfee56dce59d9aa963e74c7b4e7ce77) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add MessagesQuery over the durable replication feed.

- [#1043](https://github.com/enboxorg/enbox/pull/1043) [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Require nested protocol Query, Count, and Subscribe filters to pin the direct parent contextId, make permission revocation filtering opt-in with scalar per-grant checks, and route delegated sync scope derivation through the permissions API.

- [#1010](https://github.com/enboxorg/enbox/pull/1010) [`e781263`](https://github.com/enboxorg/enbox/commit/e78126309fc09e20be025ac2bf793632234a58f3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: mark permission records immutable

  The permissions protocol now sets `$immutable: true` on the `request`, `grant`, and `grant/revocation` paths. Permission records are write-once by design — a grant is never amended, it is revoked and re-issued — and immutability locks each record's initial-write facts (notably the `protocol` tag), which replication fingerprint domains and protocol-scoped shadow filters are computed from. Updates to existing permission records (including tags-only mutations) are now rejected with `ProtocolAuthorizationImmutableRecord` in both `processMessage` and `applyReplicatedMessage`; creating permission records and revoking grants are unaffected.

- [#1034](https://github.com/enboxorg/enbox/pull/1034) [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: remove same-CID data completion from replication feeds

- [#1041](https://github.com/enboxorg/enbox/pull/1041) [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Project `$recordLimit` occupants at read time for bounded scopes so over-limit candidates are retained uniformly while concrete Query, Read, Count, and Subscribe paths expose only the ranked occupants. Update singleton repository writes to upsert against the projected occupant.

- [#1035](https://github.com/enboxorg/enbox/pull/1035) [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove legacy sync index, wire, and sparse-tree surfaces now that replication uses durable message feeds and scoped fingerprints.

- [#1017](https://github.com/enboxorg/enbox/pull/1017) [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: wire server subscriptions through the durable message-store log and a wake-only event bus

- [#1037](https://github.com/enboxorg/enbox/pull/1037) [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: remove the legacy event-log emit surface and use store-owned wakes for embedded DWNs

- [#1012](https://github.com/enboxorg/enbox/pull/1012) [`a2bfa0d`](https://github.com/enboxorg/enbox/commit/a2bfa0dafff6a60d3b0343fcade2c6e4d7d871cf) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: carry mutable query-visibility facts (flattened `tag.*` and `published`) from the pre-delete latest write onto RecordsDelete tombstone indexes. Without them, tombstones of tagged permission records never match the permission shadow filters and published-record tombstones never match `published: true` queries and subscriptions. Immutable record facts keep coming from the initial write, and pruning an already-deleted record carries the existing tombstone's visibility facts forward.

- [#1013](https://github.com/enboxorg/enbox/pull/1013) [`f90c4b8`](https://github.com/enboxorg/enbox/commit/f90c4b8a77007337b9ec7711c14885759efab383) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: ValidationStateReader with uniform admission

  Adds `ValidationStateReader` as the validation-time state access boundary and moves admission checks to use it instead of direct `MessageStore` reads.

  `processMessage()` and `applyReplicatedMessage()` now share the same admission rules. Replication calls normal admission and maps missing local dependencies to structured `Incomplete` repair results outside validation.

  Protocol definitions are resolved with the incoming message timestamp for all entry points, and RecordsWrite immutable-property checks now run after authentication/authorization without echoing stored immutable values.

## 0.4.0

### Minor Changes

- [#996](https://github.com/enboxorg/enbox/pull/996) [`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove the speculative records-projection MessagesSync path and dependency hints. Sync now uses only full and protocol-root StateIndex roots.

  Removed the `recordsProjection` `SyncScope` variant, records-projection scope helpers, `RecordsProjection`, and the MessagesSync dependency-hint wire types/exports.

### Patch Changes

- [#998](https://github.com/enboxorg/enbox/pull/998) [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Retry sync pushes when a child record reaches a remote before its parent, while keeping malformed protocol-path failures permanent.

- [#1001](https://github.com/enboxorg/enbox/pull/1001) [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Route sync pulls through structured replicated-message admission and remove the old closure-repair compensation layer.

## 0.3.9

### Patch Changes

- [#988](https://github.com/enboxorg/enbox/pull/988) [`5908941`](https://github.com/enboxorg/enbox/commit/590894124552537f9088638b7a3527d4f7f3fda9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Treat exact RecordsWrite replays as idempotent before mutable protocol-state validation.

## 0.3.8

### Patch Changes

- [#982](https://github.com/enboxorg/enbox/pull/982) [`22dffaa`](https://github.com/enboxorg/enbox/commit/22dffaa13cceb18935a20508fb131f5bb83993dd) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Conservatively purge stale-admitted records when newly learned protocol config history clearly invalidates their initial write.

- [#959](https://github.com/enboxorg/enbox/pull/959) [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Close delegated MessagesSubscribe streams when invoked grants become invalid during delivery, surface terminal live-query errors, and keep subscription resume checkpoints monotonic.

- [#957](https://github.com/enboxorg/enbox/pull/957) [`1a9ba9d`](https://github.com/enboxorg/enbox/commit/1a9ba9db3aa09e7dd73e22e6f555c63eba978fb1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use `permissionGrantId` for direct DWN operations and `permissionGrantIds` for Messages operations.

- [#976](https://github.com/enboxorg/enbox/pull/976) [`923b14f`](https://github.com/enboxorg/enbox/commit/923b14ffc986a7c98ee11a73d979d5d869579881) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Allow delegated MessagesRead grants scoped inside a protocol to read that protocol's configuration metadata.

- [#971](https://github.com/enboxorg/enbox/pull/971) [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Support exact protocolPath and contextId subtree scope matching for Messages.Read grants. Permission records are now authorized through the protocol scope embedded in each grant record instead of blanket access from a grant scoped directly to the Permissions protocol.

- [#974](https://github.com/enboxorg/enbox/pull/974) [`650f630`](https://github.com/enboxorg/enbox/commit/650f6306d42b6aaece08a811c437a59f4eb896b3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add projected `MessagesSync` roots for `Records` primary scopes using `records-primary-scope-root-v1`.
  Projected roots exclude infrastructure records, and delegated sync cannot request infrastructure-protocol roots directly.

- [#962](https://github.com/enboxorg/enbox/pull/962) [`c801dc7`](https://github.com/enboxorg/enbox/commit/c801dc7045a109f210a1a6d7306f3e215bca9db7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Ensure MessagesSync diff responses can inline small DataStore-backed RecordsWrite payloads and cover delegated protocol-scoped diff filtering.

- [#981](https://github.com/enboxorg/enbox/pull/981) [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Include and verify payload-free initial-write dependency hints for projected sync delete tombstones.

- [#978](https://github.com/enboxorg/enbox/pull/978) [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add projected MessagesSync protocol-config closure hints and apply verified config dependencies before projected primary records.

- [#970](https://github.com/enboxorg/enbox/pull/970) [`67947ca`](https://github.com/enboxorg/enbox/commit/67947ca12d3e5e1343f3ade8dd8c6e261ad41ac3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add scoped Records projection root helpers for path and context primary CID sets.

- [#956](https://github.com/enboxorg/enbox/pull/956) [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a shared permission scope matcher and use it for scoped grant checks. Scoped grant authorization now uses exact protocolPath matching, boundary-aware contextId subtree matching, and distinct Messages grant authorization error codes.

## 0.3.7

### Patch Changes

- [#950](https://github.com/enboxorg/enbox/pull/950) [`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Handle duplicate large `RecordsWrite` delivery idempotently in SQL-backed DWNs.

  Exact duplicate writes now return `409 Conflict` before reprocessing large data streams, while SQL data and block stores tolerate overlapping duplicate inserts for the same content-addressed data.

## 0.3.6

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
  - @enbox/dids@0.1.1
  - @enbox/common@0.1.1
  - @enbox/crypto@0.1.1

## 0.3.5

### Patch Changes

- [#909](https://github.com/enboxorg/enbox/pull/909) [`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(dwn-sdk-js): surface DID and resolution metadata in `GeneralJwsVerifierGetPublicKeyNotFound`

  The previous error message — `"public key needed to verify signature not found in DID Document"` — could not distinguish a failed DID resolution (e.g. `did:dht` not yet propagated to the Pkarr relay, network error, unsupported DID method) from a genuine `kid` mismatch against a successfully resolved document. This made wallet-connect failures (e.g. `[@enbox/auth] Failed to store grant in delegate partition: GeneralJwsVerifierGetPublicKeyNotFound: ...`) effectively undebuggable.

  The verifier now includes the offending `kid`, the DID being resolved, and either the `didResolutionMetadata.error` / `errorMessage` or the list of available verification method IDs. Behaviour and error code (`GeneralJwsVerifierGetPublicKeyNotFound`) are unchanged.

## 0.3.4

### Patch Changes

- [#869](https://github.com/enboxorg/enbox/pull/869) [`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: handle duplicate message put as idempotent no-op

  MessageStore.put() now treats duplicate writes as no-ops across all
  store implementations. This prevents 500 errors when sync or
  protocol.send() re-delivers a message the DWN already has (race
  between the handler's CID check and the actual insert).

  dwn-sdk-js: added shared "idempotent put" test to testMessageStore()
  suite — runs against LevelDB and all SQL dialects automatically.

  dwn-sql-store: added isDuplicateKeyError() to detect unique constraint
  violations from PostgreSQL (23505), MySQL (ER_DUP_ENTRY/1062), SQLite
  (SQLITE_CONSTRAINT + UNIQUE), with a message-based fallback for
  unknown drivers. 10 unit tests cover all dialect error shapes.

## 0.3.3

### Patch Changes

- [#860](https://github.com/enboxorg/enbox/pull/860) [`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish delegateKeyDelivery schema and cross-device key delivery

  The delegateKeyDelivery field was added to the PermissionGrantData JSON
  schema and the agent's connect protocol in commit 2887165, but was not
  included in a subsequent publish. This caused a version mismatch where
  @enbox/agent@0.6.3 generates grants with delegateKeyDelivery but
  @enbox/dwn-sdk-js@0.3.2 rejects them with SchemaValidationAdditionalPropertyNotAllowed.

## 0.3.2

### Patch Changes

- [#792](https://github.com/enboxorg/enbox/pull/792) [`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: prevent empty messageCid in ProgressToken across EventLog and sync engine

## 0.3.1

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

## 0.3.0

### Minor Changes

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

## 0.2.2

### Patch Changes

- [#743](https://github.com/enboxorg/enbox/pull/743) [`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(dwn-sdk-js): return 409 for duplicate ProtocolsConfigure messages

  ProtocolsConfigureHandler now checks if the incoming message CID already
  exists before attempting storage. Previously, re-processing the same
  ProtocolsConfigure (e.g. when the batched-diff sync pushes a message the
  remote already has) would attempt a second INSERT into the MessageStore,
  violating the unique constraint on (tenant, messageCid) in PostgreSQL and
  returning a -32603 internal error to the client.

## 0.2.1

### Patch Changes

- [#741](https://github.com/enboxorg/enbox/pull/741) [`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(sync): batched diff protocol and direct StateIndex access

  Add a new `MessagesSync` `action: 'diff'` that collapses the entire SMT tree walk and message fetch into a single HTTP round-trip. The client sends its subtree hashes at a configurable depth, and the server returns the full set difference with inline message data for small payloads. Also bypass the `processMessage` pipeline for local SMT queries by accessing the `StateIndex` directly when the agent has an in-process DWN, with transparent RPC fallback for remote mode. Includes stream-aware retry that buffers small data payloads to avoid re-fetching on transient failures.

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
  - @enbox/crypto@0.1.0
  - @enbox/dids@0.1.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/crypto@0.0.8
  - @enbox/dids@0.0.9

## 0.1.1

### Patch Changes

- [#539](https://github.com/enboxorg/enbox/pull/539) [`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish unpublished fixes across packages

  - `@enbox/common`: `open()` in KeyValueStore interface
  - `@enbox/dids`: `DidResolverCacheMemory`, resolver lifecycle management
  - `@enbox/dwn-sdk-js`: `DidResolverCacheMemory` default in `Dwn.create()` (fixes "Database is not open" in containers)
  - `@enbox/dwn-clients`: `DwnServerInfoCacheMemory`
  - `@enbox/dwn-server`: Actor delivery, noop resolver cache, registration gate fix

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/dids@0.0.8
  - @enbox/crypto@0.0.7

## 0.1.0

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
  - @enbox/dids@0.0.7
  - @enbox/crypto@0.0.6

## 0.0.8

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/crypto@0.0.5
  - @enbox/dids@0.0.6

## 0.0.7

### Patch Changes

- [#242](https://github.com/enboxorg/enbox/pull/242) [`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/dids@0.0.5

## 0.0.6

### Patch Changes

- Updated dependencies [[`af2ba3a`](https://github.com/enboxorg/enbox/commit/af2ba3a7e9d5de44b40a38169e9296427a4f049b)]:
  - @enbox/crypto@0.0.4
  - @enbox/dids@0.0.4

## 0.0.5

### Patch Changes

- Tighten ProtocolRuleSet types: replace `[key: string]: any` with typed union, use enum types for ProtocolActionRule.who and .can, extract ProtocolTagsDefinition, ProtocolTagSchema, and ProtocolSizeDefinition as named types

## 0.0.4

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/crypto@0.0.3
  - @enbox/dids@0.0.3

## 0.0.3

### Patch Changes

- [#147](https://github.com/enboxorg/enbox/pull/147) [`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish new versions to fix MessagesSync export chain

  @enbox/agent@0.1.1 imports MessagesSync from @enbox/dwn-sdk-js, but
  @enbox/dwn-sdk-js@0.0.2 was published before that export was added.
  This bumps all three packages so downstream consumers (demo apps) can
  resolve the full dependency chain.

This package is a fork of the official DWN SDK JS package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/dwn-sdk-js](https://github.com/decentralized-identity/dwn-sdk-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
