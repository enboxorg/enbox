# @enbox/api

## 0.6.84

### Patch Changes

- [#1650](https://github.com/enboxorg/enbox/pull/1650) [`e87c522`](https://github.com/enboxorg/enbox/commit/e87c522e786c13bb86fc5ef539d205dfcc848223) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a hosted delegated test context that exercises wallet approval, delegated grants, remote DWN routing, and encrypted records through production Enbox APIs. Delegates can now use their `Protocols.Query` grant when resolving unpublished protocol definitions from a remote DWN; cached definitions are isolated by authorization and invalidated across every authorization scope after accepted configuration changes.

- Updated dependencies [[`e87c522`](https://github.com/enboxorg/enbox/commit/e87c522e786c13bb86fc5ef539d205dfcc848223), [`8936a7c`](https://github.com/enboxorg/enbox/commit/8936a7cb1312706689e7480757a948dba417a988), [`b7182d7`](https://github.com/enboxorg/enbox/commit/b7182d7b120ea616a9e55802a90760aee7ba3301)]:
  - @enbox/agent@0.8.45
  - @enbox/auth@0.6.91

## 0.6.83

### Patch Changes

- Updated dependencies [[`5d1c013`](https://github.com/enboxorg/enbox/commit/5d1c0138151b886f52e113070038336da2856490)]:
  - @enbox/dwn-clients@0.4.33
  - @enbox/agent@0.8.44
  - @enbox/auth@0.6.90

## 0.6.82

### Patch Changes

- Updated dependencies [[`b9b6e84`](https://github.com/enboxorg/enbox/commit/b9b6e84c9614adc81d63896491b2bc927e34547d)]:
  - @enbox/agent@0.8.43
  - @enbox/auth@0.6.89

## 0.6.81

### Patch Changes

- [#1642](https://github.com/enboxorg/enbox/pull/1642) [`8f4715d`](https://github.com/enboxorg/enbox/commit/8f4715d461862ea11ab560b75338ebdcd87b79bf) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix delegated role decryption to use the invoked audience route before probing unrelated grant keys

- Updated dependencies [[`8f4715d`](https://github.com/enboxorg/enbox/commit/8f4715d461862ea11ab560b75338ebdcd87b79bf)]:
  - @enbox/agent@0.8.42
  - @enbox/auth@0.6.88

## 0.6.80

### Patch Changes

- Updated dependencies [[`1af0250`](https://github.com/enboxorg/enbox/commit/1af0250c6632002121d43cc3a8d37ce20db1bc84)]:
  - @enbox/dwn-sdk-js@0.4.25
  - @enbox/agent@0.8.41
  - @enbox/auth@0.6.87
  - @enbox/dwn-clients@0.4.32

## 0.6.79

### Patch Changes

- [#1624](https://github.com/enboxorg/enbox/pull/1624) [`54cb801`](https://github.com/enboxorg/enbox/commit/54cb80166846b3395cd3543ae8a1c387ae5857d3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a DWN timestamp helper for advancing past an authoritative floor and consistently classify missing record parents.

- [#1626](https://github.com/enboxorg/enbox/pull/1626) [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: expose one identity-scoped sync status projection and terminal-failure wakes

- [#1632](https://github.com/enboxorg/enbox/pull/1632) [`eebdf97`](https://github.com/enboxorg/enbox/commit/eebdf9754773c1c8fb4836c8f3e106c2a1f60a62) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove the duplicate `Enbox` connect, refresh, and disconnect lifecycle. `ConnectionStore` now owns session lifecycle orchestration and closes the session-bound `Enbox` data facade automatically. Stores either own the `AuthManager` they create or borrow an explicitly supplied manager; caller-owned agents must be wrapped in a caller-owned manager.

- [#1633](https://github.com/enboxorg/enbox/pull/1633) [`137ce5f`](https://github.com/enboxorg/enbox/commit/137ce5f652af3f469329039cdd1cca4b675c7a36) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fail closed when a delegated application's sync registration no longer covers every manifest protocol with read permission, while preserving the auth session for wallet reapproval through `ConnectionStore.refresh()`.

- [#1626](https://github.com/enboxorg/enbox/pull/1626) [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace separate sync identity registration and update operations with an idempotent options setter, atomic routing refreshes, cross-context registration wakes, and idempotent removal.

- [#1634](https://github.com/enboxorg/enbox/pull/1634) [`1eabea1`](https://github.com/enboxorg/enbox/commit/1eabea135a67906fb9730c58244f40077e312bec) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: simplify application lifecycle, observable views, sync status, and package re-exports.

  `createConnectionStore()` now requires an application manifest and exposes one
  `ConnectionStore` type; protocol-less callers should compose `AuthManager` with
  `Enbox.fromSession()`. The store no longer exposes its internally owned auth
  manager. Connected snapshots are phase-discriminated and expose identity facts
  through `snapshot.session`. Record and context views now implement the shared
  `ObservableStore` contract with `getSnapshot()` instead of `getState()`. The
  application-level `Enbox.getDwnEndpointStatus()` convenience and the
  `ApplicationConnectionStore*` and listener aliases are removed.

  `ConnectionStore.connect()` now transparently refreshes a surviving delegated
  session when wallet reapproval is required, so applications no longer inspect
  the underlying auth manager to choose between connect and refresh. Sync policy
  is now configured when the store is created rather than per `connect()` call.

  The agent consolidates sync status projection and persistence internals and
  removes `clearDeadLetter()`, `clearAllDeadLetters()`, and the redundant
  `getRemoteSyncStatus()` wrapper; dead letters heal automatically and remote
  rows are available through `getIdentitySyncStatus(did).remotes`. Browser and
  CLI entrypoints now re-export their complete environment-safe API and auth
  surfaces.

- [#1626](https://github.com/enboxorg/enbox/pull/1626) [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Expose current advertised remote sync health and fresh targeted retries through ConnectionStore.

- Updated dependencies [[`54cb801`](https://github.com/enboxorg/enbox/commit/54cb80166846b3395cd3543ae8a1c387ae5857d3), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0), [`1eabea1`](https://github.com/enboxorg/enbox/commit/1eabea135a67906fb9730c58244f40077e312bec), [`85dfa69`](https://github.com/enboxorg/enbox/commit/85dfa69369c3ff28c41320a7a79336b2416735b1)]:
  - @enbox/dwn-sdk-js@0.4.24
  - @enbox/agent@0.8.40
  - @enbox/auth@0.6.86
  - @enbox/dwn-clients@0.4.31

## 0.6.78

### Patch Changes

- [#1608](https://github.com/enboxorg/enbox/pull/1608) [`6cfbbd5`](https://github.com/enboxorg/enbox/commit/6cfbbd5fef64846aeb54fff8c07f94266cf4c5ec) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add lazy record-page iteration and fixed-step expansion for observed record views.

- [#1609](https://github.com/enboxorg/enbox/pull/1609) [`b5c2d3e`](https://github.com/enboxorg/enbox/commit/b5c2d3eb59ac0f63d8deccca12706303318667e0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add caller-scoped abort signals to typed record subscriptions and observed record, context, invitation, and member views.

- [#1612](https://github.com/enboxorg/enbox/pull/1612) [`5ecf249`](https://github.com/enboxorg/enbox/commit/5ecf249c93a0a820e26bbcab9d10673acd6cb4eb) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a live member-context catalog that composes independently observed, decoded roots.

- [#1617](https://github.com/enboxorg/enbox/pull/1617) [`aa471e4`](https://github.com/enboxorg/enbox/commit/aa471e429731ae612f92e5df65a95c1c36036f79) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: preserve reserved JSON keys in record patches; remove unused provider-directory and notification exports

- [#1611](https://github.com/enboxorg/enbox/pull/1611) [`7d9e946`](https://github.com/enboxorg/enbox/commit/7d9e9469d6d642329e38e7a8281b5ed0af01bc02) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a V1 file-envelope codec for encrypted private file records, with an
  optional local content limit and a protocol-size calculation helper.

- [#1614](https://github.com/enboxorg/enbox/pull/1614) [`2cf5cfc`](https://github.com/enboxorg/enbox/commit/2cf5cfcaf8046fe4895233e45ff5760e083bf6bc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Resolve and cache DID-advertised DWN endpoints, expose friendly endpoint status with an opt-in service-config wake, and preserve authoritative endpoints during recovery unless explicitly replaced. Connection snapshots now expose an immediate `disconnecting` phase, and owned `Enbox.disconnect()` calls surface teardown failures.

  Remove the obsolete `getDwnEndpointUrlsForTarget()` local/remote union API and `remoteEndpointsOnly` request marker; callers now use DID-advertised endpoints and explicitly compose any known local endpoint they need.

  Use `AuthManager.restoreFromPhrase()` as the single phrase-recovery entry point; generic `connect()` and `connectVault()` no longer accept a recovery phrase.

- [#1609](https://github.com/enboxorg/enbox/pull/1609) [`b5c2d3e`](https://github.com/enboxorg/enbox/commit/b5c2d3eb59ac0f63d8deccca12706303318667e0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Expose protocol-bound record facts, stable context coordinates, squash path typing, and structured record write errors.

- Updated dependencies [[`aa471e4`](https://github.com/enboxorg/enbox/commit/aa471e429731ae612f92e5df65a95c1c36036f79), [`175222e`](https://github.com/enboxorg/enbox/commit/175222e679ab2c1c7cf293eaea8a59dab906e4f2), [`2cf5cfc`](https://github.com/enboxorg/enbox/commit/2cf5cfcaf8046fe4895233e45ff5760e083bf6bc)]:
  - @enbox/dwn-clients@0.4.30
  - @enbox/dids@0.1.10
  - @enbox/agent@0.8.39
  - @enbox/auth@0.6.85
  - @enbox/dwn-sdk-js@0.4.23

## 0.6.77

### Patch Changes

- Updated dependencies [[`2eee007`](https://github.com/enboxorg/enbox/commit/2eee007892807d44dad8ce828afe19aee7dfe18d)]:
  - @enbox/dwn-sdk-js@0.4.22
  - @enbox/agent@0.8.38
  - @enbox/auth@0.6.84
  - @enbox/dwn-clients@0.4.29

## 0.6.76

### Patch Changes

- [#1584](https://github.com/enboxorg/enbox/pull/1584) [`aa2f44c`](https://github.com/enboxorg/enbox/commit/aa2f44c13245b76e3494974a63a94e6416b26ee5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add the typed shared-context application contract. Applications declare ordered
  role groups once, then use context-bound CRUD, queries, views, path-set change
  subscriptions, membership, delivery health, invitations, and durable accepted
  context catalogs without handling tenants, grants, role records, encryption
  keys, or feed cursors. Invitation discovery uses a bounded newest-first inbox;
  unsolicited records can crowd out older invitations. Pagination continuation
  and automatic junk cleanup are not yet available.

  Role-authorized feeds now support delegated callers and bounded encrypted
  bootstrap dependencies. The sync engine persists one pull-only exact-context
  source at the verified role and endpoint, pauses instead of advancing past
  inadmissible data, and exposes explicit context refresh, forget, and leave.
  Paused sources re-check their ordered roles at that endpoint; re-following is
  the explicit way to select a different endpoint or role group.

  Typed records add cursor-free pages, bounded initial change replay, shallow
  conflict-aware patches, tombstone-aware deletes, and one observable view
  lifecycle. `@enbox/browser` now re-exports `DataForPath` alongside the existing
  typed application types, removing the need for a second API-package import.

  Pre-release view names now match that final lifecycle: use `getState()` and
  `RecordViewState` instead of `getSnapshot()` and `RecordViewSnapshot`; inspect
  `status` to distinguish loading, ready, and error. `ready` means locally usable,
  while `current` reports freshness. Use `RecordPage.next()` instead of supplying
  raw pagination cursors or deriving them from a `Record`. Connection replication
  state is `syncing`, `caught-up`, or `error`.

  Remove the obsolete high-level permission-record wrappers; advanced permission
  operations remain available through `Enbox.agent.permissions`. Remove the
  manual `Record.send()`, `Record.store()`, `Record.import()`, and `Protocol.send()`
  lifecycle. High-level creates and mutations now always persist; their `store`
  and `signAsOwner` controls are removed. Exact-message workflows remain available
  through the raw agent and `DwnApi`. Remove the unimplemented VC facade and
  `EnboxAgent.sendDidRequest()` stub; DID operations remain on `agent.did`.

  An existing delete tombstone is reused only when it was signed under the
  effective role, already satisfies the requested prune strength, and does not
  need an explicitly different timestamp. Context-bound deletion treats a
  canonical conflict with an existing tombstone as converged, while a plain
  scoped 404 still throws because it does not prove context authority.

  `DwnDataStore` is now abstract and owns record enumeration; subclasses provide
  protocol metadata, object identity, validation, and optional payload loading.
  Remove the internal-purpose `definitionsEqual` and `stripEncryptionBlocks`
  exports; protocol installation and manifest checks compare definitions
  automatically.

  Shared internal implementations replace duplicate canonicalization, protocol
  walking, configure lookup, encryption-control matching, connection-status
  reads, and validator schema ordering.

- Updated dependencies [[`aa2f44c`](https://github.com/enboxorg/enbox/commit/aa2f44c13245b76e3494974a63a94e6416b26ee5)]:
  - @enbox/agent@0.8.37
  - @enbox/auth@0.6.83
  - @enbox/common@0.1.6
  - @enbox/dwn-sdk-js@0.4.21
  - @enbox/dids@0.1.9
  - @enbox/dwn-clients@0.4.28

## 0.6.75

### Patch Changes

- [#1506](https://github.com/enboxorg/enbox/pull/1506) [`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Run role-audience delivery reconciliation and bounded transient retries in the background for each encrypted-role protocol used by an Enbox session. Work waits for a current reachable replica and wakes on startup, relevant role changes, connectivity recovery, and recipient protocol installation without delaying connection readiness or accepted writes.

- [#1512](https://github.com/enboxorg/enbox/pull/1512) [`20e1c7c`](https://github.com/enboxorg/enbox/commit/20e1c7c12cb829dd8c0da0a76bc0064df49598e6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Allow typed record views to observe bounded queries on a foreign DWN tenant with `from` and `protocolRole`, reusing the existing remote subscription and canonical query materialization path.

- [#1502](https://github.com/enboxorg/enbox/pull/1502) [`69a1c6a`](https://github.com/enboxorg/enbox/commit/69a1c6ad9c68a36e19c3f93dcc379e7ac16f4f15) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a concise `records.read(path, recordId)` form for local point reads while preserving advanced request options.

- [#1501](https://github.com/enboxorg/enbox/pull/1501) [`a2848ac`](https://github.com/enboxorg/enbox/commit/a2848acf96fee15fba5701ddb3e04f4b98787f3e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `RecordPage.next()` for continuing the same typed records query without reconstructing cursor requests.

- [#1508](https://github.com/enboxorg/enbox/pull/1508) [`16b7cbc`](https://github.com/enboxorg/enbox/commit/16b7cbc5e7d5f69dc0b87738c0cc6e69951ce649) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Expose persisted audience-key delivery state and coordinator-backed retry through typed role records. Remove raw status verification and routine update-side delivery; retain supplied-key updates for out-of-band recovery.

- [#1509](https://github.com/enboxorg/enbox/pull/1509) [`fa8346c`](https://github.com/enboxorg/enbox/commit/fa8346cd21c2edb91270b0d198312d0855244584) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Validate serialized JSON record values with optional standalone validators and expose typed failures with protocol, schema, and record context.

- Updated dependencies [[`87129bd`](https://github.com/enboxorg/enbox/commit/87129bd86cd1c3a0c0c7d288407f063e3ef5a030), [`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48), [`41ce181`](https://github.com/enboxorg/enbox/commit/41ce181a981b17cc82d50bc496b0a2cab97df820), [`cf909fd`](https://github.com/enboxorg/enbox/commit/cf909fd4f6394d81e87e0a24d6f46ea1bb76a1a1), [`cb112bc`](https://github.com/enboxorg/enbox/commit/cb112bcbc0b4e0f545ad5852a6c5fcd10fd0103b), [`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48), [`e6b1c06`](https://github.com/enboxorg/enbox/commit/e6b1c0636c3c63a9fba2dd154db38f147358c460), [`16b7cbc`](https://github.com/enboxorg/enbox/commit/16b7cbc5e7d5f69dc0b87738c0cc6e69951ce649)]:
  - @enbox/agent@0.8.36
  - @enbox/dwn-sdk-js@0.4.20
  - @enbox/auth@0.6.82
  - @enbox/dwn-clients@0.4.27

## 0.6.74

### Patch Changes

- [#1476](https://github.com/enboxorg/enbox/pull/1476) [`00dafdf`](https://github.com/enboxorg/enbox/commit/00dafdf88c517df248639680dc89616e9f42616d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Authenticate protocol configurations used for remote encryption-policy resolution and record artifacts returned through app-facing remote query, read, and initial subscription snapshot calls, bind record results to the original request filter, and verify inline or streamed record bytes against their signed CID and size. Remote protocol definitions used for encryption policy must now be signed directly by the target DID. Anonymous subscriptions now use the current transport request shape, and lazy read-only records reject data from a different record version.

  These checks authenticate returned artifacts; they do not prove result completeness or freshness because DWN query replies do not yet carry a tenant-authenticated state commitment. `RecordsCount` replies carry no signed artifacts, so their aggregate values remain assertions by the remote DWN. Initial `RecordsSubscribe` snapshots are verified, but subsequent live events remain outside this response-verification boundary.

  Streamed reads are authenticated at successful end-of-stream, so callers can observe chunks before the final CID check completes. Integrity-sensitive consumers that cannot tolerate an unauthenticated prefix must buffer the stream through successful completion before using its bytes.

- [#1492](https://github.com/enboxorg/enbox/pull/1492) [`fb7ca10`](https://github.com/enboxorg/enbox/commit/fb7ca10fdc7b58a2e97d59658063033805491a9a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add typed application manifests and structural protocol-request normalization. Applications can retain `TypedProtocol` codecs locally while projecting only raw definitions and explicit permission policies into delegated auth requests.

- [#1495](https://github.com/enboxorg/enbox/pull/1495) [`c625d63`](https://github.com/enboxorg/enbox/commit/c625d6398feff887d2051bba6e5d5e306eaa3fdf) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Expose the connected identity's aggregate sync currentness, connectivity, and
  latest engine-recorded activity through the existing framework-neutral
  connection snapshot. Export `ReplicationCurrentness` as the shared currentness
  vocabulary for sync status and observed record views. Status is driven by local
  sync state and existing events, uses the agent's canonical connectivity
  aggregation, and fences session replacement and teardown without notifying
  listeners during disposal.

- [#1494](https://github.com/enboxorg/enbox/pull/1494) [`d818618`](https://github.com/enboxorg/enbox/commit/d8186183f76b5556c26dd94a3ece5fc3db411a44) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add application protocol readiness. Owner sessions install locally, publish to
  the identity's hosted DWN, and verify the active remote definition. Delegated
  sessions validate and import the wallet-owned configuration without publishing.

- [#1496](https://github.com/enboxorg/enbox/pull/1496) [`8d288dd`](https://github.com/enboxorg/enbox/commit/8d288dd80fab6e4bcf0f92f3cde37799a13fcf05) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Let connection stores own a non-empty application manifest. Its protocols are
  the sole typed source for delegated connect, refresh, and opted-in auto-refresh
  flows, while plain stores continue to require explicit refresh protocols. Each
  restored or newly established session completes readiness before the store
  publishes it as connected. Owner sessions require local installation by default
  and can set `requireHostedReadiness` to block on hosted publication; delegate
  failures fail closed, with missing or incompatible wallet configurations
  surfaced through the existing wallet-reapproval state.

- [#1498](https://github.com/enboxorg/enbox/pull/1498) [`659372d`](https://github.com/enboxorg/enbox/commit/659372de22c2cf7481fa4d28ba2b6380483e93a4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add an isolated, real local-DWN test context under `@enbox/api/testing` and support network-free identities in the agent test harness.

- [#1482](https://github.com/enboxorg/enbox/pull/1482) [`80dab68`](https://github.com/enboxorg/enbox/commit/80dab686cb24691f6df5fdc46a61552cbeb5faf4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Keep protocol-role management on the canonical typed Records API: expose exact `$role` paths through `ProtocolRolePaths`, require a recipient when creating a role record, and document create/query/delete as the grant/list/revoke lifecycle. Explicit request annotations now use `TypedCreateRequest<Definition, Codecs, Path>`.

- [#1472](https://github.com/enboxorg/enbox/pull/1472) [`33dba16`](https://github.com/enboxorg/enbox/commit/33dba165f9f5770044ccafb9f1f0572f2f555abf) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: carry protocol roles through typed point reads and deletes, including lazy record data reads

- Updated dependencies [[`00dafdf`](https://github.com/enboxorg/enbox/commit/00dafdf88c517df248639680dc89616e9f42616d), [`fb7ca10`](https://github.com/enboxorg/enbox/commit/fb7ca10fdc7b58a2e97d59658063033805491a9a), [`c625d63`](https://github.com/enboxorg/enbox/commit/c625d6398feff887d2051bba6e5d5e306eaa3fdf), [`d818618`](https://github.com/enboxorg/enbox/commit/d8186183f76b5556c26dd94a3ece5fc3db411a44), [`659372d`](https://github.com/enboxorg/enbox/commit/659372de22c2cf7481fa4d28ba2b6380483e93a4), [`2a4223a`](https://github.com/enboxorg/enbox/commit/2a4223a8255c7c9c6efc1245021fd620f11902ba), [`9511e65`](https://github.com/enboxorg/enbox/commit/9511e6566d92bb7b89e8c35fe3f0602c3a313e4b), [`d257e04`](https://github.com/enboxorg/enbox/commit/d257e04b5001f596d28691c942ca5d0bf25c2c22), [`8b0dc99`](https://github.com/enboxorg/enbox/commit/8b0dc99476d7981a2f2bd97fabbf0ecbe4754d33)]:
  - @enbox/dwn-sdk-js@0.4.19
  - @enbox/agent@0.8.35
  - @enbox/auth@0.6.81
  - @enbox/dwn-clients@0.4.26

## 0.6.73

### Patch Changes

- [#1449](https://github.com/enboxorg/enbox/pull/1449) [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: use generic `RecordsWriteResponse<T>`, `RecordsQueryResponse<T>`, and
  `RecordsReadResponse<T>` across raw and protocol-scoped APIs, replacing the
  duplicate `TypedCreateResponse`, `TypedQueryResponse`, and `TypedReadResponse`
  types. Write and read responses now always contain a `record` property whose
  value is `undefined` when the operation did not return a record. `RecordOptions`
  no longer accepts the unused `remoteOrigin`; its `dataAccess` context remains
  the single source of truth for lazy-read routing.

- [#1461](https://github.com/enboxorg/enbox/pull/1461) [`5e9f5ce`](https://github.com/enboxorg/enbox/commit/5e9f5cecffa18004af2c891f833eb743c9f14d7e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Return application values from protocol-scoped record operations and throw `DwnResponseError` for non-success DWN replies, except that a missing read returns `undefined`. Record updates and patches now return the same canonical record handle, while successful delete, store, import, and send commands resolve without a response envelope. Raw record response types and role-audience delivery outcomes remain available from `@enbox/api/advanced`; the high-level exports no longer include those response types or `isOk`.

- [#1464](https://github.com/enboxorg/enbox/pull/1464) [`f8a7ff1`](https://github.com/enboxorg/enbox/commit/f8a7ff1f9a40af66e1bdeb313e1131d7cbe12a48) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add explicitly bounded record materialization to typed queries and observed
  views. Materialized items pair decoded values with their canonical record
  handles and can batch selected direct children declared with
  `$recordLimit.max: 1`. Add `records.set()` for those protocol-declared
  singletons on the connected tenant. Delegate-backed sets require a Records.Read
  grant for the authoritative selection as well as write authorization.

  Low-level record filters now accept a non-empty `parentId` selection so one
  child query can cover a page of parents. Bounded path-wide nested RecordsSubscribe
  requests use the same grouped record-limit projection for dependency wakes;
  RecordsQuery and RecordsCount continue to require an explicit nested scope.

  `RecordPage` and `RecordView` are now parameterized by the item they contain,
  instead of carrying a separate payload type alongside an optional item type.

- [#1463](https://github.com/enboxorg/enbox/pull/1463) [`96c5dbd`](https://github.com/enboxorg/enbox/commit/96c5dbddfb921a4972dc552a4d64ea9c7086b6ad) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace phantom schema-map typing with runtime record codecs. Typed records now encode and decode through their protocol declaration, expose application values through `Record.value()`, and use `within` as the single hierarchy selector. Remove the superseded schema-map types, caller-controlled `Record.update()` data-format overrides, generic `RecordData.json<T>()`, and root utilities namespace. Typed protocol declarations reject `$ref` composition until referenced protocol metadata can be supplied explicitly.

  Replace the public `generateTypes()` and `CodegenOptions.emitDefinition` codegen surface with `generateProtocolModule()`, which emits complete codec-backed protocol modules from protocol definitions and declared MIME formats. Expose the codec primitives through the browser and CLI facades.

- Updated dependencies [[`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c), [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c), [`f8a7ff1`](https://github.com/enboxorg/enbox/commit/f8a7ff1f9a40af66e1bdeb313e1131d7cbe12a48), [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c)]:
  - @enbox/agent@0.8.34
  - @enbox/dwn-sdk-js@0.4.18
  - @enbox/auth@0.6.80
  - @enbox/dwn-clients@0.4.25

## 0.6.72

### Patch Changes

- [#1429](https://github.com/enboxorg/enbox/pull/1429) [`f804103`](https://github.com/enboxorg/enbox/commit/f80410366f4e3798018618f2f15ed014fd3796e8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add one protocol-derived `RecordQuery` shared by typed record queries and counts, including exact path tag and data-format types. Add authenticated `DwnApi.records.count()`, preserve query/count population parity, and expose the canonical query and count-response types from browser builds. Published-date filters and sorting explicitly select published records for both operations.

  Remove the overlapping typed query aliases, `queryAll()` drains, Repository facade, and high-level subscription models. Typed records now have one query/count contract, explicit create/update operations, and no client-side upsert or parallel collection abstraction. Callers page explicitly through `query()` with its returned cursor.

  Flatten advanced RecordsSubscribe and MessagesSubscribe to their raw DWN contract: a required subscription handler and the unmodified protocol reply. Remove `LiveQuery`, `TypedLiveQuery`, `MessagesLiveQuery`, record hydration, and `includeRecords`; a later observed-view API will be the sole high-level reactive model. Use `filter.contextId` for typed child selection; protocol identity and the exact-parent fence are derived internally. These intentional breaking changes remove the superseded exports from API, browser, and CLI without compatibility aliases.

  Resolve delegated record-read grants from the wire filter as the single protocol source, reject empty typed context IDs, and surface permission-store failures instead of silently treating them as missing grants. Delegated permission lookup now reuses a bounded grant catalog across record contexts while matching each requested scope independently.

  Resolve delegated record writes and deletes against their protocol path and context instead of selecting protocol-wide grants only. Permission lookups now reuse cached catalogs by default and expose `forceRefresh` for an explicit store refresh, while a scope miss refreshes the store so newly imported grants are immediately visible.

- [#1447](https://github.com/enboxorg/enbox/pull/1447) [`764a470`](https://github.com/enboxorg/enbox/commit/764a470290d7167f1e1d8bb0702947aceeec3c0c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use `Record<T>` as the single mutable record handle returned by both the
  protocol-scoped and low-level APIs. Protocol-scoped create, query, read,
  observe, update, and delete operations now preserve their payload type directly
  on that canonical record instead of allocating a forwarding wrapper;
  `@enbox/browser` re-exports `Record` accordingly. The redundant `rawRecord`
  escape hatch is removed because the returned object is already the underlying
  record.

  The `TypedRecord`, `TypedRecordData`, `TypedRecordUpdateParams`,
  `TypedRecordPatch`, `TypedRecordUpdateResult`, and `TypedRecordDeleteResult`
  exports are removed. Use `Record<T>`, `RecordData<T>`,
  `RecordUpdateParams<T>`, `RecordPatch<T>`, `RecordUpdateResult<T>`, and
  `RecordDeleteResult<T>` respectively. Payload typing now belongs to the record,
  so consume typed JSON with `record.data.json()` rather than supplying a type
  argument to `json()`. The internal `createRecordData` factory is no longer
  exported from the package root; application code should consume `RecordData<T>`
  through a `Record` or `ReadOnlyRecord`. `ReadOnlyRecord.data.json()` now returns
  `unknown`; anonymous callers should validate the parsed value before use.

  `Record.update({ data })` continues to replace the complete payload and now
  requires the full `T` on a typed record. Use `Record.patch()` for shallow
  partial JSON-object updates.

- [#1446](https://github.com/enboxorg/enbox/pull/1446) [`23d84a4`](https://github.com/enboxorg/enbox/commit/23d84a4cd94d169423d9fbe5c84b5e7bd803b134) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: make `$recordLimit: { max }` one deterministic read-time visibility contract

  Query, Read, Count, and subscription snapshots now select at most `max` occupants independently for every direct-parent scope in an ancestor selection. Occupancy is ranked by initial creation time and record ID before authorization, caller filters, sorting, and pagination. Level, browser, SQLite, MySQL, and PostgreSQL share that definition.

  Observed typed views widen only limited paths to the structural occupancy scope, so a sibling write or delete can wake and rematerialize an exact-record view when its record is promoted or demoted.

  Protocol definitions no longer select a write-time strategy. Valid competing records remain stored, and the unused `purgeOldest` wire value, strategy enum, and write-time strategy guard have been removed.

- [#1428](https://github.com/enboxorg/enbox/pull/1428) [`2c78d33`](https://github.com/enboxorg/enbox/commit/2c78d3371c3cb26fea33245866326b9e43df528e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: construct updated-date pagination cursors from record message timestamps

- [#1435](https://github.com/enboxorg/enbox/pull/1435) [`e07585c`](https://github.com/enboxorg/enbox/commit/e07585ce0e7ffcb65a32c51e1da22d48588339e0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `records.observe()` as the single high-level reactive Records primitive. It
  publishes bounded immutable query snapshots, treats local subscription events
  as wake hints, coalesces rematerialization, and reports loading, ready, stale,
  or error currentness from the existing sync registration and link state.

  Sessions now carry an owner-controlled `AbortSignal`; lock, disconnect,
  shutdown, identity replacement, and successful grant refresh fence resources
  bound to the previous authorization. Refresh reuses the delegate identity but
  installs a new session lifetime; a failed or denied refresh leaves the existing
  session active. `AuthManager` installs the exact active session before publishing
  the wake-only `session-start` event; consumers read the authoritative manager
  session instead of reconstructing a capability from event metadata, and the
  redundant `AuthSessionInfo` projection is removed. A view publishes one terminal
  error before closing when that lifetime ends. Successful automatic refresh makes
  `ConnectionStore` publish a replacement `Enbox`; direct session consumers
  recreate resources from the replacement `AuthManager.session`.

  Sync registration changes and ephemeral pull currentness are now observable.
  Replication-link snapshots combine durable checkpoints with current controller
  status, connectivity, and whether every accepted remote-feed wake is covered
  by a completed pull pass; checkpoint events remain progress-only.

- [#1434](https://github.com/enboxorg/enbox/pull/1434) [`50c40fd`](https://github.com/enboxorg/enbox/commit/50c40fd50950d5a25c0d5c342f55b078adf247e9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: make context scopes select an exact context plus only `/`-delimited descendants across Level, browser, and SQL stores

  Nested query, count, and subscription selections may now start at an ancestor context, and the typed API forwards that single context selector without deriving a second `parentId` fence. Message protocol-path and context-prefix filters use the same segment-aware store primitive, including Unicode descendants. `SubtreeFilter` is supported only for the hierarchical `contextId` and `protocolPath` indexes; other indexes reject it at the store boundary. SQL migrations give hierarchical columns byte-stable ordering so their exact-and-range predicates remain indexable without allowing case variants to cross a context boundary.

  Records filters now reject malformed context paths at message validation, and typed nested-path queries fail synchronously when their required `contextId` scope is omitted. Valid context IDs are at most 600 characters and contain only non-empty alphanumeric segments separated by `/`.

  SQL migration 005 changes the `contextId` and `protocolPath` collations and rebuilds the context index. It may briefly hold a schema lock while a populated message table is upgraded. MySQL storage now requires MySQL 8.0 or newer.

- Updated dependencies [[`ca04167`](https://github.com/enboxorg/enbox/commit/ca04167e6e6e61eea56eedd5eb7acbc3b909fd4c), [`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774), [`f804103`](https://github.com/enboxorg/enbox/commit/f80410366f4e3798018618f2f15ed014fd3796e8), [`23d84a4`](https://github.com/enboxorg/enbox/commit/23d84a4cd94d169423d9fbe5c84b5e7bd803b134), [`2c78d33`](https://github.com/enboxorg/enbox/commit/2c78d3371c3cb26fea33245866326b9e43df528e), [`e07585c`](https://github.com/enboxorg/enbox/commit/e07585ce0e7ffcb65a32c51e1da22d48588339e0), [`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774), [`50c40fd`](https://github.com/enboxorg/enbox/commit/50c40fd50950d5a25c0d5c342f55b078adf247e9), [`7a6abfd`](https://github.com/enboxorg/enbox/commit/7a6abfd92ca2cb019f5a7aa5260d12d06c59ce8d), [`713c757`](https://github.com/enboxorg/enbox/commit/713c7577c2ece2f59929f5f226abdf6cf40a7e1c)]:
  - @enbox/common@0.1.5
  - @enbox/dwn-sdk-js@0.4.17
  - @enbox/agent@0.8.33
  - @enbox/auth@0.6.79
  - @enbox/dids@0.1.8
  - @enbox/dwn-clients@0.4.24

## 0.6.71

### Patch Changes

- Updated dependencies [[`4043f46`](https://github.com/enboxorg/enbox/commit/4043f46136cf23f08eb092976f1cb12cbb600ca7), [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2), [`61ceb57`](https://github.com/enboxorg/enbox/commit/61ceb575144c0eea39cee6938ce2f2c474c8b6f2), [`64115f8`](https://github.com/enboxorg/enbox/commit/64115f8d9fbfb37bf16cb04603556a0873de6b53), [`4426e72`](https://github.com/enboxorg/enbox/commit/4426e72a213fffbf420ce776fb2adb31c9c4f9b3), [`82e2f62`](https://github.com/enboxorg/enbox/commit/82e2f628fd6441eb4ca81be0b13952d11fbe6cba), [`a0aa94e`](https://github.com/enboxorg/enbox/commit/a0aa94e727320063dbb806aab57979abbbfb82b1), [`c603c33`](https://github.com/enboxorg/enbox/commit/c603c333387644b2d250cc4e778be1ebb14581ff), [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2), [`87afa05`](https://github.com/enboxorg/enbox/commit/87afa055a2aa23e7981f83dbff1ff2add138ea94), [`4062e4a`](https://github.com/enboxorg/enbox/commit/4062e4ab7e588c11a7f2fcfe302ac5cf048e4624), [`686c918`](https://github.com/enboxorg/enbox/commit/686c918e33d11af23314a2be421d3b66028020a1), [`7a437b2`](https://github.com/enboxorg/enbox/commit/7a437b2bed8cdb88b30eec86fb6420801845a352), [`06793a4`](https://github.com/enboxorg/enbox/commit/06793a4ddb8577b6f73c59db001e89fa2499f18c)]:
  - @enbox/agent@0.8.32
  - @enbox/dwn-clients@0.4.23
  - @enbox/dwn-sdk-js@0.4.16
  - @enbox/auth@0.6.78

## 0.6.70

### Patch Changes

- [#1384](https://github.com/enboxorg/enbox/pull/1384) [`f688ea7`](https://github.com/enboxorg/enbox/commit/f688ea711b3bb3547e47f8f1697e3af54c441b2c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: optionally hydrate message subscription record events with version-pinned stored data

## 0.6.69

### Patch Changes

- [#1382](https://github.com/enboxorg/enbox/pull/1382) [`bad337e`](https://github.com/enboxorg/enbox/commit/bad337e27a7f5e1029780401a419bc5c313c03ff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Keep low-level record reads, queries, subscriptions, and writes on the raw bytes stored by the DWN, and lazily decrypt the application view from each RecordsWrite encryption envelope. Decryption failures now surface when `record.data` is consumed instead of failing the containing read, query, or subscription.

- [#1383](https://github.com/enboxorg/enbox/pull/1383) [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Make protocol definitions the sole source of record encryption policy and remove caller-controlled encryption switches. Reject records whose stored representation does not match their type policy, prevent used paths from changing representation under the same protocol URI, and separate encrypted `grantKey` records from plaintext `wrappedGrantKey` envelopes in the core encryption protocol.

- Updated dependencies [[`bad337e`](https://github.com/enboxorg/enbox/commit/bad337e27a7f5e1029780401a419bc5c313c03ff), [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3), [`6688e32`](https://github.com/enboxorg/enbox/commit/6688e327e27d52a55d6daabdcfe1195f2954a67a)]:
  - @enbox/agent@0.8.31
  - @enbox/dwn-sdk-js@0.4.15
  - @enbox/auth@0.6.77
  - @enbox/dwn-clients@0.4.22

## 0.6.68

### Patch Changes

- Updated dependencies [[`257fa11`](https://github.com/enboxorg/enbox/commit/257fa11e014b59a758e93dcdeb8dec9b6deb989b), [`da812fc`](https://github.com/enboxorg/enbox/commit/da812fcfd501f4135682683f2960793c0ad37d26), [`83020bd`](https://github.com/enboxorg/enbox/commit/83020bdcf86e4db86f00f877c88427fc7e36f7bc), [`8b9ab70`](https://github.com/enboxorg/enbox/commit/8b9ab7017d5ac9d37920249c54d75264cad1fe99), [`3804b5d`](https://github.com/enboxorg/enbox/commit/3804b5dc1ddb94cd7beaff7045345efd474f6965), [`b334497`](https://github.com/enboxorg/enbox/commit/b33449751d36dd5c3bfddce7d208c75a9418bf50), [`08c6912`](https://github.com/enboxorg/enbox/commit/08c69121ecdfcfe2adc7758e7242d28b894caa95)]:
  - @enbox/agent@0.8.30
  - @enbox/auth@0.6.76

## 0.6.67

### Patch Changes

- Updated dependencies [[`9dd09a6`](https://github.com/enboxorg/enbox/commit/9dd09a6d76a98eb54da813b1a3dc9b648527f7f3), [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca), [`535922a`](https://github.com/enboxorg/enbox/commit/535922a5c7c4312bac6155cfa34cff38bf458080)]:
  - @enbox/agent@0.8.29
  - @enbox/dwn-clients@0.4.21
  - @enbox/dwn-sdk-js@0.4.14
  - @enbox/auth@0.6.75

## 0.6.66

### Patch Changes

- [#1350](https://github.com/enboxorg/enbox/pull/1350) [`c4ee0bc`](https://github.com/enboxorg/enbox/commit/c4ee0bc057fb5b2278926fe1d9d1add618acc08d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(agent): typed error taxonomy for recipient-side role-audience decrypt failures

  Recipient-side decrypt failures now throw `AudienceDecryptError` carrying a machine-readable
  `cause` (`'not-wrapped-for-role' | 'delivery-missing' | 'role-not-held' | 'audience-superseded' |
'remote-unverifiable' | 'unknown'`) plus `recordId`, `protocol`, `recipientDid`, and a `detail`
  string, instead of one generic prose error with the real cause swallowed by logging. Previously
  logger-only observations (rejected role-holder verification, skipped grantKeys, unreachable-remote
  lookups) are folded into the error data. `@enbox/api` re-exports the class and cause type so apps
  can catch it from record data rejections.

- [#1357](https://github.com/enboxorg/enbox/pull/1357) [`48149b9`](https://github.com/enboxorg/enbox/commit/48149b970383af60d1113019c7a54b3f26cdd24c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(api): cross-tenant typed writes (#973) and api-layer parity batch

  - `records.write` / typed `records.create` gain `from` — remote role- or grant-authorized writes into another tenant's DWN, routed via `sendDwnRequest` like remote reads; returned records are stamped with `remoteOrigin`. `Record.update` gains an opt-in `from` for cross-tenant co-updates; after a successful update the author is re-derived from the newly signed message and the remote origin is re-homed consistently on both the returned record and the mutated original. `recipientRolePublicKey` stays unsupported on the remote path (agent throws, surfaced); `audienceKeyDelivery` is never fabricated for remote writes.
  - Typed `create` forwards `dateCreated` / `messageTimestamp`; typed path-level `delete` forwards `prune`.
  - Public accessors: `enbox.dwn`, `enbox.connectedDid`, `enbox.delegateDid`, `typedEnbox.dwn` — the documented escape hatch to the raw layer.
  - `TypedRecord.patch()` / `Record.patch()` — read-merge-write partial updates with null-deletes; `update({ data })` docs (and typing) fixed to reflect full-payload replacement.
  - `records.queryAll()` on both the raw and typed surfaces — async-generator drain with internal pagination, liveness guards (repeated-cursor and consecutive-empty-page termination), a `maxPages` budget independent of the `maxRecords` yield cap, and loud call-time validation of numeric options.
  - Typed query/read/subscribe derive the engine-required bare `parentId` + compound `contextId` filters from `parentContextId` on nested paths.
  - `TypedEnbox.verifyInstalled()` — strict install verification (canonical definition compare + `$keyAgreement` coverage) with owner/delegate-aware statuses and a typed `WalletReapprovalRequiredError` instead of silent stale-delegate imports; `stripEncryptionBlocks` is now exported.

- [#1343](https://github.com/enboxorg/enbox/pull/1343) [`851ffb4`](https://github.com/enboxorg/enbox/commit/851ffb40396e710b596463c62b055034b3882fad) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: surface `audienceKeyDelivery` and accept `recipientRolePublicKey` on write surfaces

  `records.write()`, `Record.update()`, and the typed `records.create()` / `TypedRecord.update()` surfaces now forward the agent's role-audience key-delivery outcome, and `records.write()` / typed create accept an optional caller-supplied `recipientRolePublicKey` that is passed through to `agent.processDwnRequest()`. `AudienceKeyDeliveryOutcome` is re-exported from the package index so apps can inspect delivery outcomes without reaching into `@enbox/agent` or private `_dwn` internals.

- [#1338](https://github.com/enboxorg/enbox/pull/1338) [`1774805`](https://github.com/enboxorg/enbox/commit/1774805f09934ff839c3008bfcbf2bf4fff04963) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(api): first-class `messages.subscribe()` — the message-level local change feed

  New `enbox.dwn.messages.subscribe({ filters?, cursor?, from? })` returning a lightweight `MessagesLiveQuery`: one `event` per message recorded on the tenant's log across every interface the filters cover (multiple filters per subscription), each carrying the raw message plus a routing `MessageDescriptor` (`interface`, `method`, `protocol`, `protocolPath`, `recordId`, `contextId`, `author`, `messageTimestamp`). Where `records.subscribe()` hydrates full `Record` objects for one filter, this is the cache-invalidation primitive: subscribe once per profile on the local store — which sync keeps populated, so events fire for sync-applied messages too — and route each change without re-querying. Includes transport lifecycle events (`eose`, `disconnected`/`reconnecting`/`reconnected`, terminal `error`), cursor resume, remote (`from`) targeting, and delegated `Messages.Read` grant resolution for single-protocol filter sets.

- [#1355](https://github.com/enboxorg/enbox/pull/1355) [`cd6940e`](https://github.com/enboxorg/enbox/commit/cd6940e28434cac31587bd2745ce3411d670bfa3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add a framework-agnostic connection store and a typed connect-denied error

  - `@enbox/auth`: connect, refresh, and wallet-connect denials now throw a typed `ConnectDeniedError` (messages unchanged); branch on the new `isConnectDeniedError()` predicate instead of string-matching error messages.
  - `@enbox/api`: new `createConnectionStore()` — a headless, subscribable store that composes `AuthManager` + `Enbox` into one observable state machine (`initializing | disconnected | connecting | connected | error`), with `getSnapshot()`/`subscribe()` for `useSyncExternalStore`-style bindings, in-flight guards, delegated connection monitoring, and `dispose()` teardown.
  - `@enbox/browser`: re-exports `createConnectionStore`, its types, `ConnectDeniedError`, and `isConnectDeniedError`.

- [#1303](https://github.com/enboxorg/enbox/pull/1303) [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e) Thanks [@poindex-bot](https://github.com/poindex-bot)! - chore: resolve mechanical SonarCloud maintainability findings

  Behavior-preserving cleanup across the monorepo clearing the bulk of Sonar's
  maintainability findings (no functional changes):

  - `node:` protocol prefixes on Node built-in imports (S7772)
  - `export…from` re-exports (S7763)
  - `switch` → `if` where simpler, preserving all cases/defaults (S1301)
  - nested ternary extraction (S3358), nullish coalescing where falsy-safe (S6606/S6644),
    optional chaining (S6582), `.at()` (S7755), `for…of` (S4138), `else if` (S6660),
    `.includes()`/`.findLast()`/`Math.max()` (S7765/S7750/S7766)
  - `structuredClone()` over `JSON.parse(JSON.stringify())` (S7784)
  - `Set` for existence checks (S7776), combined `Array#push` calls (S7778)
  - `TypeError` for post-type-check throws, with messages (S7786/S7722)

  Verified: full monorepo build + lint clean; crypto, common, dwn-sdk-js, dids,
  dwn-clients, protocol-codegen, auth, api, and agent test suites all green.

- [#1354](https://github.com/enboxorg/enbox/pull/1354) [`76be6bb`](https://github.com/enboxorg/enbox/commit/76be6bba0e0f7a3ae25ee1829915974581960982) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: opt-in decryption of subscription event payloads

  `RecordsSubscribe` requests now accept `encryption: true` (auto-enabled by the typed layer on `encryptionRequired` paths): the agent decrypts the subscribe reply's initial snapshot entries and each event's inline payload before delivery, so subscription consumers read plaintext from `record.data` without re-reading every record through the read path. Events without inline data (large records) keep the lazy decrypting read; a record that cannot be decrypted never kills the subscription — its inline ciphertext is withheld and `record.data` rejects with the decryption error via the lazy read.

- Updated dependencies [[`c4ee0bc`](https://github.com/enboxorg/enbox/commit/c4ee0bc057fb5b2278926fe1d9d1add618acc08d), [`6ad8f08`](https://github.com/enboxorg/enbox/commit/6ad8f08b2b87a9915ddbc6b289284a2b6635fbbd), [`16c8ea4`](https://github.com/enboxorg/enbox/commit/16c8ea46380d303fb20eeec7047b5f1f286f661f), [`3e6d5fe`](https://github.com/enboxorg/enbox/commit/3e6d5fe51f3ae16db0c08174132bcdc828f15c93), [`e83cb4b`](https://github.com/enboxorg/enbox/commit/e83cb4b05e7f184e515ccd547f5ac1c346fea045), [`f41a755`](https://github.com/enboxorg/enbox/commit/f41a755adfe769ad1ca5b00b7275059f2ed2305e), [`73a76e1`](https://github.com/enboxorg/enbox/commit/73a76e1099ebfb6b8e399431541a43d14d3df5ec), [`8f6cc7d`](https://github.com/enboxorg/enbox/commit/8f6cc7de740771a15a7eb1732d0597b2082fb347), [`d5c8e83`](https://github.com/enboxorg/enbox/commit/d5c8e8300ffb30ba89580ea0a37c3f9513470572), [`3309d87`](https://github.com/enboxorg/enbox/commit/3309d87efdea35ca784917b3b0ec05362a4a7c81), [`7f4c4e7`](https://github.com/enboxorg/enbox/commit/7f4c4e7b485f47b8cf0d6c40d60054363f4c56e3), [`a40eb11`](https://github.com/enboxorg/enbox/commit/a40eb11831bd9e669ed1a6b5dca58274be82d9de), [`e33cf82`](https://github.com/enboxorg/enbox/commit/e33cf820fec511d09676f5ea5473fa6db8727c5f), [`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441), [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`8d59d0b`](https://github.com/enboxorg/enbox/commit/8d59d0b39e7d0cfefdb4a416da669aa77a69cda7), [`cd6940e`](https://github.com/enboxorg/enbox/commit/cd6940e28434cac31587bd2745ce3411d670bfa3), [`757cff1`](https://github.com/enboxorg/enbox/commit/757cff17cbb8bec36f806eec1a8ee3606f3c9ae2), [`2b50952`](https://github.com/enboxorg/enbox/commit/2b5095252fc621d6ea35db5a330759009c2a88e2), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`9889d7d`](https://github.com/enboxorg/enbox/commit/9889d7dcaf9fb53d2da7efea08b8d3c3f173932e), [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67), [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`d6f72b4`](https://github.com/enboxorg/enbox/commit/d6f72b4ec9f50fd86f288021416c7f22a61c60ed), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`4c32046`](https://github.com/enboxorg/enbox/commit/4c320469d38f4f67c51ad6b82edca397fc0bd4c2), [`4498e5a`](https://github.com/enboxorg/enbox/commit/4498e5ad249bb38e24047d1665b6a19849f5c8a9), [`132cd4a`](https://github.com/enboxorg/enbox/commit/132cd4ad25c428991e60ea52f2871457169e9072), [`48fde39`](https://github.com/enboxorg/enbox/commit/48fde39d5857f8b7bb70ddbfc857ad276e49d27c), [`74dd445`](https://github.com/enboxorg/enbox/commit/74dd445b283e476eb3c26d6fbd3f193c32fa924e), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0), [`76be6bb`](https://github.com/enboxorg/enbox/commit/76be6bba0e0f7a3ae25ee1829915974581960982), [`9e4be6d`](https://github.com/enboxorg/enbox/commit/9e4be6de0206e0c3e2cbd5e235405cffef75e1bc), [`b964d48`](https://github.com/enboxorg/enbox/commit/b964d48ab993934337c348f6655e9923bfa409f3), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`c7d1b82`](https://github.com/enboxorg/enbox/commit/c7d1b8265a73134cd55a6330b29d1ede137302c4), [`d564725`](https://github.com/enboxorg/enbox/commit/d564725121d6488eea74790cb5279b505ff09dc9), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`d275b31`](https://github.com/enboxorg/enbox/commit/d275b31fb738a8f2aa2744dd14a4090481d2c9f4), [`418030a`](https://github.com/enboxorg/enbox/commit/418030a14cd84a889a57aefe0237e5a2f2c39395), [`5b4e0d3`](https://github.com/enboxorg/enbox/commit/5b4e0d305ab9c142111ba8ec553a4d4bd18a8ff7), [`dd311d4`](https://github.com/enboxorg/enbox/commit/dd311d4459a8da2b1c6e0b233c10a5fa299e6548), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`024cd55`](https://github.com/enboxorg/enbox/commit/024cd5592e5cecfbdea348747deb34da9ba21b94), [`b5f49ac`](https://github.com/enboxorg/enbox/commit/b5f49ace4e6ab9e1caf23afb2cdd8735d44985b3)]:
  - @enbox/agent@0.8.28
  - @enbox/dwn-sdk-js@0.4.13
  - @enbox/auth@0.6.74
  - @enbox/dwn-clients@0.4.20
  - @enbox/dids@0.1.7
  - @enbox/common@0.1.4

## 0.6.65

### Patch Changes

- Updated dependencies [[`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131)]:
  - @enbox/agent@0.8.27
  - @enbox/dwn-clients@0.4.19
  - @enbox/auth@0.6.73

## 0.6.64

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.26
  - @enbox/auth@0.6.72

## 0.6.63

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.25
  - @enbox/auth@0.6.71

## 0.6.62

### Patch Changes

- [#1274](https://github.com/enboxorg/enbox/pull/1274) [`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83) Thanks [@poindex-bot](https://github.com/poindex-bot)! - Add delegated connect-session status, expiry error helpers, opt-in monitoring, and same-delegate grant refresh across the auth and browser APIs. Refresh requests now carry an explicit wallet UI signal, reuse the existing delegate keys on popup and relay transports, and select fresh active grants over expired or superseded grants. Connect results now fail closed when grants come from the wrong owner, exceed the requested scope, or contain no usable requested grant.

- Updated dependencies [[`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83)]:
  - @enbox/agent@0.8.24
  - @enbox/auth@0.6.70

## 0.6.61

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.23
  - @enbox/auth@0.6.69
  - @enbox/dids@0.1.6
  - @enbox/dwn-clients@0.4.18
  - @enbox/dwn-sdk-js@0.4.12

## 0.6.60

### Patch Changes

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11
  - @enbox/agent@0.8.22
  - @enbox/auth@0.6.68
  - @enbox/dwn-clients@0.4.17

## 0.6.59

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.21
  - @enbox/auth@0.6.67

## 0.6.58

### Patch Changes

- Updated dependencies [[`672a13f`](https://github.com/enboxorg/enbox/commit/672a13fd33dde00afdf8fd4fe2de649f06a1b93f)]:
  - @enbox/agent@0.8.20
  - @enbox/auth@0.6.66

## 0.6.57

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.19
  - @enbox/auth@0.6.65

## 0.6.56

### Patch Changes

- Updated dependencies [[`95ff115`](https://github.com/enboxorg/enbox/commit/95ff11501400dbd0786f14e769d50b833a8a871d)]:
  - @enbox/agent@0.8.18
  - @enbox/auth@0.6.64

## 0.6.55

### Patch Changes

- Updated dependencies [[`a61819a`](https://github.com/enboxorg/enbox/commit/a61819abe3e53751782e50df9a1b26e52e65463f)]:
  - @enbox/agent@0.8.17
  - @enbox/auth@0.6.63

## 0.6.54

### Patch Changes

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/agent@0.8.16
  - @enbox/auth@0.6.62
  - @enbox/dwn-sdk-js@0.4.10
  - @enbox/dwn-clients@0.4.16
  - @enbox/dids@0.1.5

## 0.6.53

### Patch Changes

- [#1215](https://github.com/enboxorg/enbox/pull/1215) [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve SonarCloud maintainability issues (S3863/S6594)

  Behavior-preserving source cleanups:

  - S3863: merge duplicate `import` statements from the same module into a
    single statement (re-sorting to satisfy the repo's `sort-imports` rule).
  - S6594: use `RegExp.exec()` instead of `String#match()` for the non-global
    route/type regexes in the DWN server and `universalTypeOf`.

- Updated dependencies [[`378f3d4`](https://github.com/enboxorg/enbox/commit/378f3d4b07a011e9f56852cfc0a4e9da8cd13bd4), [`d7f0a87`](https://github.com/enboxorg/enbox/commit/d7f0a87b211c7eb3fb2ee1e048a51b2deab2305a), [`49449ad`](https://github.com/enboxorg/enbox/commit/49449ade45463baa3ac2190c5455b7dba1f1e39b), [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a), [`c12b323`](https://github.com/enboxorg/enbox/commit/c12b3239ce03bf29bcd2b3a37c8c650c7b29ace1), [`98f4348`](https://github.com/enboxorg/enbox/commit/98f4348bfbfb7d5ddbc91787f4187958998ba011), [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9), [`55581c7`](https://github.com/enboxorg/enbox/commit/55581c71dc1ea7bc8715f92c56ba71692f7bc33e), [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/agent@0.8.15
  - @enbox/auth@0.6.61
  - @enbox/dwn-clients@0.4.15
  - @enbox/common@0.1.3
  - @enbox/dids@0.1.4
  - @enbox/dwn-sdk-js@0.4.9

## 0.6.52

### Patch Changes

- Updated dependencies [[`d7467fe`](https://github.com/enboxorg/enbox/commit/d7467fef30d809e25bd0c840338301b9b9d912e0)]:
  - @enbox/agent@0.8.14
  - @enbox/auth@0.6.60

## 0.6.51

### Patch Changes

- [#1187](https://github.com/enboxorg/enbox/pull/1187) [`96ea6cb`](https://github.com/enboxorg/enbox/commit/96ea6cbda08a4bb6540d8a4e2664278f82d6fba8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: restore the active identity (not a stale delegate), remove revoked delegates on disconnect, and surface authorization failures in delegate protocol ensure

  restoreSession preferred any connected identity over the persisted active marker, so a leftover delegate from a disconnected session (grants revoked) shadowed the current one and every call failed with 401. Disconnect now also removes the dead delegate identity locally after clean revocation (kept while revocations are queued for retry), and TypedEnbox reports the query status when the wallet's protocol definition cannot be fetched instead of misreporting a revoked grant as a missing protocol.

- Updated dependencies [[`96ea6cb`](https://github.com/enboxorg/enbox/commit/96ea6cbda08a4bb6540d8a4e2664278f82d6fba8), [`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/auth@0.6.59
  - @enbox/agent@0.8.13
  - @enbox/dwn-sdk-js@0.4.8
  - @enbox/dwn-clients@0.4.14

## 0.6.50

### Patch Changes

- Updated dependencies [[`60a9abb`](https://github.com/enboxorg/enbox/commit/60a9abb62e3c16368793f17b9ee0e735938ae804), [`0dd7dff`](https://github.com/enboxorg/enbox/commit/0dd7dffff90360b0d0e6d82574b3b9a33a872ab0)]:
  - @enbox/agent@0.8.12
  - @enbox/auth@0.6.58

## 0.6.49

### Patch Changes

- Updated dependencies [[`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979)]:
  - @enbox/dwn-clients@0.4.13
  - @enbox/agent@0.8.11
  - @enbox/auth@0.6.57

## 0.6.48

### Patch Changes

- Updated dependencies [[`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331), [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff), [`9211810`](https://github.com/enboxorg/enbox/commit/921181002eacc4fdec2264c1334cc7e91b3b0781)]:
  - @enbox/agent@0.8.10
  - @enbox/auth@0.6.56

## 0.6.47

### Patch Changes

- [#1152](https://github.com/enboxorg/enbox/pull/1152) [`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish browser-conditioned entrypoints without Node global shim requirements

- [#1120](https://github.com/enboxorg/enbox/pull/1120) [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency footprint by moving optional backends behind subpath imports and optional peer dependencies, removing unused DID and helper packages, and replacing small CLI/runtime dependencies with built-in implementations.

- Updated dependencies [[`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251), [`7ddb0d6`](https://github.com/enboxorg/enbox/commit/7ddb0d677065483968ef9d80773e3fd81048f4ad), [`37895ff`](https://github.com/enboxorg/enbox/commit/37895ff511258ed48d10660b1f73ce597e818921), [`cda1d31`](https://github.com/enboxorg/enbox/commit/cda1d31b4c8a7df444beadd0271ff50a3482fa00), [`5de6973`](https://github.com/enboxorg/enbox/commit/5de6973f98216a3732800a6ec461520b47171902), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`042879e`](https://github.com/enboxorg/enbox/commit/042879ea1e05d45b99ab35e23f1ab2f730afa757), [`efa5171`](https://github.com/enboxorg/enbox/commit/efa5171b36aa0f46e957e74506323f9cbd4d8dc7), [`97dced6`](https://github.com/enboxorg/enbox/commit/97dced6b0eb80fccbd71ea5a8a1c250ba40153bb), [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e), [`78cd3e5`](https://github.com/enboxorg/enbox/commit/78cd3e5b8412b308077f318b58bf5fd3db63d996), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`23ae738`](https://github.com/enboxorg/enbox/commit/23ae7389a4c14aedf360c5b3b3bbdd8c274ef53a), [`b38dd5e`](https://github.com/enboxorg/enbox/commit/b38dd5ec24129a37e8e2bb17b3173144ac9bb863), [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`96bc5f5`](https://github.com/enboxorg/enbox/commit/96bc5f5c2d80f0cb543042e3f41f5c2d4156c3d3), [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6), [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c), [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688), [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852), [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46), [`57c66a3`](https://github.com/enboxorg/enbox/commit/57c66a34079625793c8b26028f29d1eb63b969ef)]:
  - @enbox/agent@0.8.9
  - @enbox/auth@0.6.55
  - @enbox/dids@0.1.3
  - @enbox/dwn-sdk-js@0.4.7
  - @enbox/common@0.1.2
  - @enbox/dwn-clients@0.4.12

## 0.6.46

### Patch Changes

- Updated dependencies [[`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1), [`d8726ea`](https://github.com/enboxorg/enbox/commit/d8726eae2002fc45e479d850b1fefd1af70bbb80)]:
  - @enbox/agent@0.8.8
  - @enbox/auth@0.6.54
  - @enbox/dwn-clients@0.4.11

## 0.6.45

### Patch Changes

- Updated dependencies [[`2333413`](https://github.com/enboxorg/enbox/commit/23334132ac1b6441e249e4482535df6a049f87d4), [`b96eb50`](https://github.com/enboxorg/enbox/commit/b96eb508d7a9ebd6ec7a7a15fec62e7e26d12a18), [`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7), [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37), [`bae4e73`](https://github.com/enboxorg/enbox/commit/bae4e730197e389f1458aac70f3a8e664432b7c9), [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc)]:
  - @enbox/agent@0.8.7
  - @enbox/auth@0.6.53
  - @enbox/dwn-clients@0.4.10

## 0.6.44

### Patch Changes

- Updated dependencies [[`41233ae`](https://github.com/enboxorg/enbox/commit/41233ae542882a1245734d0bdf9435dfab919793)]:
  - @enbox/agent@0.8.6
  - @enbox/auth@0.6.52

## 0.6.43

### Patch Changes

- [#1072](https://github.com/enboxorg/enbox/pull/1072) [`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add bounded, display-only connect session metadata to permission grants and default connect-created grants to a hard 24-hour expiration.

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/agent@0.8.5
  - @enbox/auth@0.6.51
  - @enbox/dwn-clients@0.4.9

## 0.6.42

### Patch Changes

- [#1070](https://github.com/enboxorg/enbox/pull/1070) [`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use `Records.Read` as the canonical read-like records permission for read, query, subscribe, and count operations. Connect requests now emit only read/write/delete record permissions, reject obsolete record query/subscribe/count grant scopes, and keep protocol configuration wallet-owned instead of delegating `Protocols.Configure` to apps. Delegate `TypedEnbox` auto-configuration imports the wallet's signed protocol configuration locally instead of requiring a delegated configure grant.

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/agent@0.8.4
  - @enbox/auth@0.6.50
  - @enbox/dwn-clients@0.4.8

## 0.6.41

### Patch Changes

- Updated dependencies [[`7ee6ff9`](https://github.com/enboxorg/enbox/commit/7ee6ff98bd01a673aab23f46d69db1b90f8ccd91)]:
  - @enbox/agent@0.8.3
  - @enbox/auth@0.6.49

## 0.6.40

### Patch Changes

- [#985](https://github.com/enboxorg/enbox/pull/985) [`7ff772b`](https://github.com/enboxorg/enbox/commit/7ff772bc41965463e571471f54800ce019c0f625) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(api): expose `squash` on typed `records.create`

  The typed `create` wrapper now forwards the `squash` directive to the underlying
  `records.write`, so `$squash`-enabled protocol paths can be compacted through the
  typed surface instead of dropping the flag.

- Updated dependencies [[`5a2498f`](https://github.com/enboxorg/enbox/commit/5a2498f49582db6a51e50fd0c78bb3d622460d84), [`4d96b19`](https://github.com/enboxorg/enbox/commit/4d96b19e36be398dde948e783b9240d93ec57aa2)]:
  - @enbox/auth@0.6.48
  - @enbox/agent@0.8.2
  - @enbox/dwn-clients@0.4.7

## 0.6.39

### Patch Changes

- Updated dependencies [[`7baefc6`](https://github.com/enboxorg/enbox/commit/7baefc69fcae948ce93b9fa4ee69aea050ac2f2b)]:
  - @enbox/auth@0.6.47

## 0.6.38

### Patch Changes

- [#1050](https://github.com/enboxorg/enbox/pull/1050) [`8bb1af2`](https://github.com/enboxorg/enbox/commit/8bb1af25e772c730de185a4e4b6fdf5b1aead052) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: forward identity sync protocol scope through Enbox.connect

- [#1041](https://github.com/enboxorg/enbox/pull/1041) [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Project `$recordLimit` occupants at read time for bounded scopes so over-limit candidates are retained uniformly while concrete Query, Read, Count, and Subscribe paths expose only the ranked occupants. Update singleton repository writes to upsert against the projected occupant.

- [#1005](https://github.com/enboxorg/enbox/pull/1005) [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove Bun fetch stream buffering workarounds and pass data streams through HTTP and storage paths directly.

- Updated dependencies [[`12413b1`](https://github.com/enboxorg/enbox/commit/12413b121b5387a1eb03faee4651b3770e1b2f6e), [`db83e50`](https://github.com/enboxorg/enbox/commit/db83e508fbc8e1628ef736c46a590aad6dec432a), [`777bd26`](https://github.com/enboxorg/enbox/commit/777bd26c428c6f1562fed743831f085b683541d5), [`69c6367`](https://github.com/enboxorg/enbox/commit/69c6367a2c597ba858eed0eb28de099ab491199e), [`15817c9`](https://github.com/enboxorg/enbox/commit/15817c96e407175f4c8fb4a56a784bc56aa9959a), [`09f7002`](https://github.com/enboxorg/enbox/commit/09f700217297b8101f4689f5e8a84c8a910f2def), [`0e4f67c`](https://github.com/enboxorg/enbox/commit/0e4f67c0c76c5d56603a5d5115ee7253d90fa0c9), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`228d8dc`](https://github.com/enboxorg/enbox/commit/228d8dcd2d211f7953b86e7e7c4358d9fdb27827), [`79a860d`](https://github.com/enboxorg/enbox/commit/79a860d2a007c4eb9092d46221bda61fbb0e8348), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`4ed695f`](https://github.com/enboxorg/enbox/commit/4ed695f18e4f9b2a4a2a68ca47fb39e4933e35b2), [`8928c5d`](https://github.com/enboxorg/enbox/commit/8928c5dfb6b5d8e44db016222bdb9acb8941f099), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549), [`49e2a4b`](https://github.com/enboxorg/enbox/commit/49e2a4be2db6692219519674e2b2f2b2db5c9c23), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`97fffdf`](https://github.com/enboxorg/enbox/commit/97fffdfa827995c75497fe22a2a7631fb7c0a22d), [`4129d17`](https://github.com/enboxorg/enbox/commit/4129d1712503ad67010630f729ef37d4ea8fc27b)]:
  - @enbox/agent@0.8.1
  - @enbox/auth@0.6.46
  - @enbox/dwn-clients@0.4.6

## 0.6.37

### Patch Changes

- Updated dependencies [[`817e816`](https://github.com/enboxorg/enbox/commit/817e8162ed0393402d05ad903a3fd976f84fa8fc)]:
  - @enbox/auth@0.6.45

## 0.6.36

### Patch Changes

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/agent@0.8.0
  - @enbox/dwn-clients@0.4.5
  - @enbox/auth@0.6.44

## 0.6.35

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.7.10
  - @enbox/auth@0.6.43
  - @enbox/dwn-clients@0.4.4

## 0.6.34

### Patch Changes

- Updated dependencies [[`4837d72`](https://github.com/enboxorg/enbox/commit/4837d725a96739c2c5fae892018087b238577e8a)]:
  - @enbox/agent@0.7.9
  - @enbox/auth@0.6.42

## 0.6.33

### Patch Changes

- [#959](https://github.com/enboxorg/enbox/pull/959) [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Close delegated MessagesSubscribe streams when invoked grants become invalid during delivery, surface terminal live-query errors, and keep subscription resume checkpoints monotonic.

- Updated dependencies [[`6aaab40`](https://github.com/enboxorg/enbox/commit/6aaab40bffd77b09d05275f2d786b8091c336188), [`edd4b0f`](https://github.com/enboxorg/enbox/commit/edd4b0f27685de001bcff3cb9ca75410708043b0), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3), [`5bcc5ac`](https://github.com/enboxorg/enbox/commit/5bcc5ac00a2c478c09737e725d6df50d4d017c2f), [`92011b6`](https://github.com/enboxorg/enbox/commit/92011b6938b0e59eabf3b7ee3849f6e5f339c7a3), [`e7946e7`](https://github.com/enboxorg/enbox/commit/e7946e7e7e517be5c1c1b9c643f6e01305252ef9), [`37cac82`](https://github.com/enboxorg/enbox/commit/37cac82c0f3476f1e76eeae22665b1656a4c687e), [`31111b6`](https://github.com/enboxorg/enbox/commit/31111b651716e2a56f68fba93a43891e38c82161), [`6222ba9`](https://github.com/enboxorg/enbox/commit/6222ba9c90552e891cd4797196835544bd437a38), [`485bc75`](https://github.com/enboxorg/enbox/commit/485bc757375824265de3c294a00db9ab826620c8)]:
  - @enbox/agent@0.7.8
  - @enbox/dwn-clients@0.4.3
  - @enbox/auth@0.6.41

## 0.6.32

### Patch Changes

- Updated dependencies [[`540babf`](https://github.com/enboxorg/enbox/commit/540babff775a2943ec9688027b95c1825c29c72b)]:
  - @enbox/agent@0.7.7
  - @enbox/auth@0.6.40

## 0.6.31

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.7.6
  - @enbox/auth@0.6.39
  - @enbox/dwn-clients@0.4.2

## 0.6.30

### Patch Changes

- Updated dependencies [[`c1fefdb`](https://github.com/enboxorg/enbox/commit/c1fefdb1f8caec7a421ea4c2465d4d2c96a33f76)]:
  - @enbox/agent@0.7.5
  - @enbox/auth@0.6.38

## 0.6.29

### Patch Changes

- Updated dependencies [[`9a713ce`](https://github.com/enboxorg/enbox/commit/9a713ce549e1dfe07121baa6a2837abb9b0b71a7)]:
  - @enbox/agent@0.7.4
  - @enbox/auth@0.6.37

## 0.6.28

### Patch Changes

- Updated dependencies [[`e58dd0a`](https://github.com/enboxorg/enbox/commit/e58dd0a517fe1fbb6c8e7c862904493b02353293)]:
  - @enbox/agent@0.7.3
  - @enbox/auth@0.6.36

## 0.6.27

### Patch Changes

- Updated dependencies [[`749c657`](https://github.com/enboxorg/enbox/commit/749c657136988b07084d79ae3506e7c4c72c65aa)]:
  - @enbox/auth@0.6.35

## 0.6.26

### Patch Changes

- [#937](https://github.com/enboxorg/enbox/pull/937) [`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Register agent DID for sync in vault connect and import-from-phrase flows to enable seed phrase recovery. Rename `localConnect` to `vaultConnect` and `LocalConnectOptions` to `VaultConnectOptions` (old names preserved as deprecated aliases). Export `IdentityProtocolDefinition` and `JwkProtocolDefinition` from `@enbox/agent`.

- Updated dependencies [[`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27)]:
  - @enbox/agent@0.7.2
  - @enbox/auth@0.6.34

## 0.6.25

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
  - @enbox/agent@0.7.1
  - @enbox/common@0.1.1
  - @enbox/auth@0.6.33
  - @enbox/dwn-clients@0.4.1

## 0.6.24

### Patch Changes

- Updated dependencies [[`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999)]:
  - @enbox/agent@0.7.0
  - @enbox/dwn-clients@0.4.0
  - @enbox/auth@0.6.32

## 0.6.23

### Patch Changes

- Updated dependencies [[`55f20c8`](https://github.com/enboxorg/enbox/commit/55f20c83218b97f5091aad8d450bfc32e8958c77)]:
  - @enbox/agent@0.6.8
  - @enbox/auth@0.6.31

## 0.6.22

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.6.7
  - @enbox/auth@0.6.30
  - @enbox/dwn-clients@0.3.3

## 0.6.21

### Patch Changes

- [#871](https://github.com/enboxorg/enbox/pull/871) [`b35f5cb`](https://github.com/enboxorg/enbox/commit/b35f5cb8eb726dd26bcb83b2082d3190a83a36f7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf: eliminate startup and reload bottlenecks

  - Cache vault `getDid()` result (avoids JWE decrypt + BearerDid.import on every call)
  - Eliminate duplicate X25519 context key derivation in `postWriteKeyDelivery()`
  - Parallelize grant processing, vault encryptions, storage writes, and post-write operations
  - Cache sync targets with 30s TTL (avoids DID resolution on every sync tick)
  - Cache `encryptionRequired` / `hasEncryptedTypes` at construction time
  - Replace protocol init TtlCache with permanent Set
  - Skip unnecessary `lock()` in `unlock()` when already locked

- Updated dependencies [[`1240bb1`](https://github.com/enboxorg/enbox/commit/1240bb167ffedc051f5a1e4beb08463080d18ae0), [`b35f5cb`](https://github.com/enboxorg/enbox/commit/b35f5cb8eb726dd26bcb83b2082d3190a83a36f7), [`149e0b7`](https://github.com/enboxorg/enbox/commit/149e0b79ded21a7f558ecd8e2c5e6268b4d6ba2e)]:
  - @enbox/agent@0.6.6
  - @enbox/auth@0.6.29

## 0.6.20

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.6.5
  - @enbox/auth@0.6.28
  - @enbox/dwn-clients@0.3.2

## 0.6.19

### Patch Changes

- Updated dependencies [[`b9c667f`](https://github.com/enboxorg/enbox/commit/b9c667f6dc7994b257fefd19ed6db35a19477d98)]:
  - @enbox/auth@0.6.27

## 0.6.18

### Patch Changes

- Updated dependencies [[`7452b53`](https://github.com/enboxorg/enbox/commit/7452b53b7e574a220f5bc98bbc80c8a033bfd5db)]:
  - @enbox/auth@0.6.26

## 0.6.17

### Patch Changes

- Updated dependencies [[`e582ab0`](https://github.com/enboxorg/enbox/commit/e582ab05e6f242ee99e00dc0e94853ee2dcc5e51)]:
  - @enbox/auth@0.6.25

## 0.6.16

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/agent@0.6.4
  - @enbox/auth@0.6.24
  - @enbox/dwn-clients@0.3.1

## 0.6.15

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

- Updated dependencies [[`57b1b52`](https://github.com/enboxorg/enbox/commit/57b1b52dcf80f2a4e995d649bb64c9e0b9eac9d8)]:
  - @enbox/agent@0.6.3
  - @enbox/auth@0.6.23

## 0.6.14

### Patch Changes

- Updated dependencies [[`140bd84`](https://github.com/enboxorg/enbox/commit/140bd8474d0a333fe0b5428e1835d8176d269293), [`928f72f`](https://github.com/enboxorg/enbox/commit/928f72fb81beb7a979908e323ebe6510358b31b6)]:
  - @enbox/agent@0.6.2
  - @enbox/auth@0.6.22

## 0.6.13

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

- Updated dependencies [[`d3ae193`](https://github.com/enboxorg/enbox/commit/d3ae193f546443e0a3ceb059cd721aaae2844ae3)]:
  - @enbox/agent@0.6.1
  - @enbox/auth@0.6.21

## 0.6.12

### Patch Changes

- Updated dependencies [[`963d366`](https://github.com/enboxorg/enbox/commit/963d366de71e9e6c077e0ed1ad11904e8a587c92), [`f7b4c79`](https://github.com/enboxorg/enbox/commit/f7b4c79f5a11a4d3de7836bb1ee56e47c90faf3b), [`28fd8ed`](https://github.com/enboxorg/enbox/commit/28fd8ed952df6ea032f246180370169758a1b0f8)]:
  - @enbox/agent@0.6.0
  - @enbox/dwn-clients@0.3.0
  - @enbox/auth@0.6.20

## 0.6.11

### Patch Changes

- Updated dependencies [[`1c567c0`](https://github.com/enboxorg/enbox/commit/1c567c008e60738e7fbbba5f511cf201c96f183e)]:
  - @enbox/agent@0.5.16
  - @enbox/auth@0.6.19

## 0.6.10

### Patch Changes

- Updated dependencies [[`98eb9be`](https://github.com/enboxorg/enbox/commit/98eb9be0c616da886db5d43e3186874e050d44c2)]:
  - @enbox/agent@0.5.15
  - @enbox/auth@0.6.18

## 0.6.9

### Patch Changes

- Updated dependencies [[`6b77eee`](https://github.com/enboxorg/enbox/commit/6b77eeed4d0ae4b99b14631b41eb7ebaf0dd9587)]:
  - @enbox/agent@0.5.14
  - @enbox/auth@0.6.17

## 0.6.8

### Patch Changes

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/agent@0.5.13
  - @enbox/auth@0.6.16
  - @enbox/dwn-clients@0.2.6

## 0.6.7

### Patch Changes

- Updated dependencies [[`43d805e`](https://github.com/enboxorg/enbox/commit/43d805e51b63c358f1c9c1a51623d0c5f44446fe)]:
  - @enbox/agent@0.5.12
  - @enbox/auth@0.6.15

## 0.6.6

### Patch Changes

- Updated dependencies [[`5818860`](https://github.com/enboxorg/enbox/commit/5818860e2bca5201ff368d4748393efb1544d7a2)]:
  - @enbox/dwn-clients@0.2.5
  - @enbox/agent@0.5.11
  - @enbox/auth@0.6.14

## 0.6.5

### Patch Changes

- Updated dependencies [[`3199425`](https://github.com/enboxorg/enbox/commit/319942541442670d8f1fd203adc522781d3cee72)]:
  - @enbox/agent@0.5.10
  - @enbox/auth@0.6.13

## 0.6.4

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/agent@0.5.9
  - @enbox/auth@0.6.12
  - @enbox/dwn-clients@0.2.4

## 0.6.3

### Patch Changes

- Updated dependencies [[`3ce537a`](https://github.com/enboxorg/enbox/commit/3ce537a4f5e5137b6cedf65af50c33ddbdf6a6a2)]:
  - @enbox/agent@0.5.8
  - @enbox/auth@0.6.11

## 0.6.2

### Patch Changes

- Updated dependencies [[`e269cbf`](https://github.com/enboxorg/enbox/commit/e269cbf58cf7c29fc0e1e7865ecfa7f42ea54122)]:
  - @enbox/auth@0.6.10
  - @enbox/agent@0.5.7

## 0.6.1

### Patch Changes

- Updated dependencies [[`682fb85`](https://github.com/enboxorg/enbox/commit/682fb858343319e3a4da54b08017382596896d6a), [`c8360c3`](https://github.com/enboxorg/enbox/commit/c8360c3856eebec89d717003fe3e0e21a9f182fe)]:
  - @enbox/agent@0.5.6
  - @enbox/auth@0.6.9

## 0.6.0

### Minor Changes

- [#750](https://github.com/enboxorg/enbox/pull/750) [`efd0116`](https://github.com/enboxorg/enbox/commit/efd011676082e098d17a26de82f15c3669ff43ae) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(api): add protocol-wide subscribe() to TypedEnbox

  TypedEnbox now exposes a `subscribe()` method that listens for record
  changes across the entire protocol, regardless of protocolPath. Unlike
  `records.subscribe(path)` which scopes to a single level, this catches
  creates, updates, and deletes at every level of the protocol hierarchy.

## 0.5.11

### Patch Changes

- Updated dependencies [[`3910ebb`](https://github.com/enboxorg/enbox/commit/3910ebb5b25d29161359d7ffa426ac85534f16a6)]:
  - @enbox/auth@0.6.8
  - @enbox/agent@0.5.5

## 0.5.10

### Patch Changes

- Updated dependencies [[`d6b643d`](https://github.com/enboxorg/enbox/commit/d6b643ddab34bf8d82226c368727a3566ae84d48)]:
  - @enbox/agent@0.5.4
  - @enbox/auth@0.6.7

## 0.5.9

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.5.3
  - @enbox/auth@0.6.6
  - @enbox/dwn-clients@0.2.3

## 0.5.8

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/agent@0.5.2
  - @enbox/auth@0.6.5
  - @enbox/dwn-clients@0.2.2

## 0.5.7

### Patch Changes

- Updated dependencies [[`5f3e33e`](https://github.com/enboxorg/enbox/commit/5f3e33edf3dee9268716c8ac8c049da3abf010e4)]:
  - @enbox/auth@0.6.4

## 0.5.6

### Patch Changes

- Updated dependencies [[`4c7c71e`](https://github.com/enboxorg/enbox/commit/4c7c71efa25a1eee115ef30424bc6c97189aa8f3)]:
  - @enbox/auth@0.6.3

## 0.5.5

### Patch Changes

- [#734](https://github.com/enboxorg/enbox/pull/734) [`12804b1`](https://github.com/enboxorg/enbox/commit/12804b1a0e4d97b811691b9bdc79f3a897eac161) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(api): skip auto-encryption for delegates in all TypedEnbox operations

  Delegates don't have the wallet owner's private keys, so they can't
  derive encryption keys locally. When operating as a delegate, TypedEnbox
  now skips `encryption: true` for all operations:

  - `configure()` / `_autoConfigureOnce()` — skip encryption key derivation
  - `records.create()` — skip client-side encryption
  - `records.query()` — skip client-side decryption
  - `records.read()` — skip client-side decryption

  The wallet already configured the protocol with encryption keys during
  connect. Encrypted record operations are handled by the owner's DWN.

  Also adds `DwnApi.isDelegate` getter for clean delegate detection.

## 0.5.4

### Patch Changes

- [#732](https://github.com/enboxorg/enbox/pull/732) [`c9c817a`](https://github.com/enboxorg/enbox/commit/c9c817a7c58e0cacb113044949749c60ea9ca3d2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(api): skip encryption key derivation for delegates in TypedEnbox configure

  When operating as a delegate, `TypedEnbox.configure()` and
  `_autoConfigureOnce()` no longer attempt to derive encryption keys
  from the connected DID. The delegate doesn't have the owner's private
  keys, so encryption key derivation fails with "Key not found".

  The wallet already configures the protocol with encryption keys during
  the connect flow — the delegate only needs the protocol definition
  installed locally without re-deriving keys.

## 0.5.3

### Patch Changes

- [#730](https://github.com/enboxorg/enbox/pull/730) [`219dbe8`](https://github.com/enboxorg/enbox/commit/219dbe8d0bda309f465e88857deef7aad32469de) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(api): auto-enable encryption in TypedEnbox when protocol types require it

  When a protocol type has `encryptionRequired: true`, TypedEnbox now
  automatically passes `encryption: true` to the underlying DWN API for
  `create()`, `query()`, `read()`, `configure()`, and `_autoConfigureOnce()`.

  This eliminates the need for dapp developers to manually pass
  `encryption: true` on every record operation — the protocol definition
  is the single source of truth.

## 0.5.2

### Patch Changes

- Updated dependencies [[`ef5dc9b`](https://github.com/enboxorg/enbox/commit/ef5dc9b28527538205c0e08032017649ba20964d)]:
  - @enbox/auth@0.6.2

## 0.5.1

### Patch Changes

- Updated dependencies [[`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7), [`fc923cb`](https://github.com/enboxorg/enbox/commit/fc923cb6a1f6d8e56f616a69d3e61345898d2cf9)]:
  - @enbox/agent@0.5.1
  - @enbox/dwn-clients@0.2.1
  - @enbox/auth@0.6.1

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
  - @enbox/agent@0.5.0
  - @enbox/auth@0.6.0
  - @enbox/dwn-clients@0.2.0
  - @enbox/common@0.1.0

## 0.4.4

### Patch Changes

- Updated dependencies [[`fd02228`](https://github.com/enboxorg/enbox/commit/fd02228b247aa5de903051155813ce49f210b62c)]:
  - @enbox/agent@0.4.0
  - @enbox/auth@0.5.0

## 0.4.3

### Patch Changes

- Updated dependencies [[`2d2d4b1`](https://github.com/enboxorg/enbox/commit/2d2d4b1fd1400d1d8983ed17576a329da226b104)]:
  - @enbox/auth@0.4.0

## 0.4.2

### Patch Changes

- [#664](https://github.com/enboxorg/enbox/pull/664) [`34f02a8`](https://github.com/enboxorg/enbox/commit/34f02a8a7883fbdff925c2191dc7486b01909711) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix @enbox/auth dependency version (0.2.0 was never published, now points to 0.3.1)

## 0.4.1

### Patch Changes

- Updated dependencies [[`22d724e`](https://github.com/enboxorg/enbox/commit/22d724eb415b3eea71983ab6aecd5810efa8c6bc)]:
  - @enbox/agent@0.3.1
  - @enbox/auth@0.3.1

## 0.4.0

### Minor Changes

- [#615](https://github.com/enboxorg/enbox/pull/615) [`dc0b65d`](https://github.com/enboxorg/enbox/commit/dc0b65da49fca793b5ec5737aa6a584f3a4edf47) Thanks [@LiranCohen](https://github.com/LiranCohen)! - BREAKING: Rename `Web5` class to `Enbox` and delegate auth to `@enbox/auth`

  - Rename `Web5` to `Enbox`, `TypedWeb5` to `TypedEnbox`, and all associated types
  - Replace the 267-line `connect()` monolith with a thin synchronous factory that accepts `{ session: AuthSession }` or raw `{ agent, connectedDid, delegateDid? }` parameters
  - Remove `processConnectedGrants`, `cleanUpIdentity`, and all auth/registration/vault logic from `@enbox/api` (now lives in `@enbox/auth`)
  - Add `@enbox/auth` as a dependency
  - Preserve deprecated `Web5` and `TypedWeb5` re-exports for migration

### Patch Changes

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

- Updated dependencies [[`d20a8b9`](https://github.com/enboxorg/enbox/commit/d20a8b9299db09290303e679115a5eeb144c2469), [`b147be2`](https://github.com/enboxorg/enbox/commit/b147be2d2e5cb20d9265b86bf38cedc42b19b178), [`a48bdd4`](https://github.com/enboxorg/enbox/commit/a48bdd4b6f9261821ad9470ce849699bc045c80f), [`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b), [`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/auth@0.3.0
  - @enbox/agent@0.3.0
  - @enbox/dwn-clients@0.1.0
  - @enbox/common@0.0.7

## 0.3.2

### Patch Changes

- Updated dependencies [[`7a68c55`](https://github.com/enboxorg/enbox/commit/7a68c5509da7d01700240b630ac529cbf94a629a)]:
  - @enbox/dwn-clients@0.0.9
  - @enbox/agent@0.2.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/common@0.0.6
  - @enbox/dwn-clients@0.0.8
  - @enbox/agent@0.2.1

## 0.3.0

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
  - @enbox/agent@0.2.0
  - @enbox/common@0.0.5
  - @enbox/dwn-clients@0.0.7

## 0.2.4

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/dwn-clients@0.0.6
  - @enbox/agent@0.1.9
  - @enbox/common@0.0.4

## 0.2.3

### Patch Changes

- [#279](https://github.com/enboxorg/enbox/pull/279) [`c36ffb2`](https://github.com/enboxorg/enbox/commit/c36ffb203d8b5eaefffc698f053be6262f1b4ca6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix TypedWeb5 injecting `schema: undefined` into DWN filters for protocol types that only define `dataFormats` (no `schema`). This caused the DWN SDK's RecordsFilter validation to fail silently, hanging wallet loading for protocols like ProfileProtocol whose `avatar`/`hero` types have no schema.

## 0.2.2

### Patch Changes

- Updated dependencies [[`a111281`](https://github.com/enboxorg/enbox/commit/a111281ad3fb209680073154a95d97d26fc3edf8)]:
  - @enbox/dwn-clients@0.0.5
  - @enbox/agent@0.1.8

## 0.2.1

### Patch Changes

- Updated dependencies [[`8a2f650`](https://github.com/enboxorg/enbox/commit/8a2f650c88f4b78f415dcacc23d7f4c82bc9a67b)]:
  - @enbox/agent@0.1.7

## 0.2.0

### Minor Changes

- [#242](https://github.com/enboxorg/enbox/pull/242) [`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.

### Patch Changes

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/agent@0.1.6
  - @enbox/dwn-clients@0.0.4

## 0.1.1

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.1.5
  - @enbox/dwn-clients@0.0.3

## 0.1.0

### Minor Changes

- Add typed protocol API: defineProtocol() factory, TypedDwnApi class with type-safe write/query/read/delete/subscribe/configure methods, DwnApi.using() entry point, and generic Record.data.json<T>() return type

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.1.4
  - @enbox/dwn-clients@0.0.2

## 0.0.8

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/common@0.0.3
  - @enbox/agent@0.1.3

## 0.0.7

### Patch Changes

- [#147](https://github.com/enboxorg/enbox/pull/147) [`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish new versions to fix MessagesSync export chain

  @enbox/agent@0.1.1 imports MessagesSync from @enbox/dwn-sdk-js, but
  @enbox/dwn-sdk-js@0.0.2 was published before that export was added.
  This bumps all three packages so downstream consumers (demo apps) can
  resolve the full dependency chain.

- Updated dependencies [[`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca)]:
  - @enbox/agent@0.1.2

## 0.0.6

### Patch Changes

- [#140](https://github.com/enboxorg/enbox/pull/140) [`3120dd0`](https://github.com/enboxorg/enbox/commit/3120dd0d2ffc0977d331d297af0665d5593b2d4e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: republish with correct @enbox/agent@0.1.1 dependency

  Previous attempts resolved workspace:_ to @enbox/agent@0.1.0 because bun
  kept the stale lockfile resolution. This release regenerates the lockfile
  from scratch so workspace:_ correctly resolves to @enbox/agent@0.1.1.

## 0.0.5

### Patch Changes

- [#135](https://github.com/enboxorg/enbox/pull/135) [`bd7399d`](https://github.com/enboxorg/enbox/commit/bd7399d850609fad8e01672378d3e8ac42d7f5a3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: republish with correct @enbox/agent dependency version

  The previous @enbox/api@0.0.4 was published with a dependency on
  @enbox/agent@0.1.0 (which has broken workspace:_ references) instead of
  @enbox/agent@0.1.1. This happened because the lockfile was stale when
  bun pm pack resolved the workspace:_ reference.

  The release workflow now regenerates the lockfile after version bumps
  to prevent this from recurring.

## 0.0.4

### Patch Changes

- [#128](https://github.com/enboxorg/enbox/pull/128) [`6e5401f`](https://github.com/enboxorg/enbox/commit/6e5401fbd72bf5dabccf71fa592bf14b2fe6eb8a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: republish with resolved workspace dependencies

  The previous releases of @enbox/agent@0.1.0 and @enbox/api@0.0.3 contained
  literal `workspace:*` strings in their published dependencies, making them
  uninstallable outside the monorepo. This patch release uses `bun publish`
  which correctly resolves workspace references to actual version numbers.

- Updated dependencies [[`6e5401f`](https://github.com/enboxorg/enbox/commit/6e5401fbd72bf5dabccf71fa592bf14b2fe6eb8a)]:
  - @enbox/agent@0.1.1

## 0.0.3

### Patch Changes

- [#46](https://github.com/enboxorg/enbox/pull/46) [`b0aca19`](https://github.com/enboxorg/enbox/commit/b0aca19fbbf0828184e2413f0c5cf9fd4274ea56) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Consolidate @enbox/user-agent, @enbox/proxy-agent, and @enbox/identity-agent into @enbox/agent. The Web5UserAgent class is now exported directly from @enbox/agent. The separate packages are deprecated.

- Updated dependencies [[`b0aca19`](https://github.com/enboxorg/enbox/commit/b0aca19fbbf0828184e2413f0c5cf9fd4274ea56)]:
  - @enbox/agent@0.1.0

This package is a fork of the official Web5 API package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/web5-js](https://github.com/decentralized-identity/web5-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
