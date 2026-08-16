# @enbox/agent

## 0.8.45

### Patch Changes

- [#1650](https://github.com/enboxorg/enbox/pull/1650) [`e87c522`](https://github.com/enboxorg/enbox/commit/e87c522e786c13bb86fc5ef539d205dfcc848223) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a hosted delegated test context that exercises wallet approval, delegated grants, remote DWN routing, and encrypted records through production Enbox APIs. Delegates can now use their `Protocols.Query` grant when resolving unpublished protocol definitions from a remote DWN; cached definitions are isolated by authorization and invalidated across every authorization scope after accepted configuration changes.

- [#1648](https://github.com/enboxorg/enbox/pull/1648) [`8936a7c`](https://github.com/enboxorg/enbox/commit/8936a7cb1312706689e7480757a948dba417a988) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: reject private key material in unencrypted DWN DID records

## 0.8.44

### Patch Changes

- Updated dependencies [[`5d1c013`](https://github.com/enboxorg/enbox/commit/5d1c0138151b886f52e113070038336da2856490)]:
  - @enbox/dwn-clients@0.4.33

## 0.8.43

### Patch Changes

- [#1644](https://github.com/enboxorg/enbox/pull/1644) [`b9b6e84`](https://github.com/enboxorg/enbox/commit/b9b6e84c9614adc81d63896491b2bc927e34547d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: admit complete live subscription events directly and reserve durable feed queries for baseline and recovery

## 0.8.42

### Patch Changes

- [#1642](https://github.com/enboxorg/enbox/pull/1642) [`8f4715d`](https://github.com/enboxorg/enbox/commit/8f4715d461862ea11ab560b75338ebdcd87b79bf) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix delegated role decryption to use the invoked audience route before probing unrelated grant keys

## 0.8.41

### Patch Changes

- [#1637](https://github.com/enboxorg/enbox/pull/1637) [`1af0250`](https://github.com/enboxorg/enbox/commit/1af0250c6632002121d43cc3a8d37ce20db1bc84) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add request-time app identity hints, compatible session metadata, one-hour grant defaults, provider-selected lifetimes, and recoverable profile-locked reconnect routes

- Updated dependencies [[`1af0250`](https://github.com/enboxorg/enbox/commit/1af0250c6632002121d43cc3a8d37ce20db1bc84)]:
  - @enbox/dwn-sdk-js@0.4.25
  - @enbox/connect@0.1.21
  - @enbox/dwn-clients@0.4.32

## 0.8.40

### Patch Changes

- [#1626](https://github.com/enboxorg/enbox/pull/1626) [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: expose one identity-scoped sync status projection and terminal-failure wakes

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

- Updated dependencies [[`54cb801`](https://github.com/enboxorg/enbox/commit/54cb80166846b3395cd3543ae8a1c387ae5857d3), [`85dfa69`](https://github.com/enboxorg/enbox/commit/85dfa69369c3ff28c41320a7a79336b2416735b1)]:
  - @enbox/dwn-sdk-js@0.4.24
  - @enbox/connect@0.1.20
  - @enbox/dwn-clients@0.4.31

## 0.8.39

### Patch Changes

- [#1614](https://github.com/enboxorg/enbox/pull/1614) [`2cf5cfc`](https://github.com/enboxorg/enbox/commit/2cf5cfcaf8046fe4895233e45ff5760e083bf6bc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Resolve and cache DID-advertised DWN endpoints, expose friendly endpoint status with an opt-in service-config wake, and preserve authoritative endpoints during recovery unless explicitly replaced. Connection snapshots now expose an immediate `disconnecting` phase, and owned `Enbox.disconnect()` calls surface teardown failures.

  Remove the obsolete `getDwnEndpointUrlsForTarget()` local/remote union API and `remoteEndpointsOnly` request marker; callers now use DID-advertised endpoints and explicitly compose any known local endpoint they need.

  Use `AuthManager.restoreFromPhrase()` as the single phrase-recovery entry point; generic `connect()` and `connectVault()` no longer accept a recovery phrase.

- Updated dependencies [[`aa471e4`](https://github.com/enboxorg/enbox/commit/aa471e429731ae612f92e5df65a95c1c36036f79), [`175222e`](https://github.com/enboxorg/enbox/commit/175222e679ab2c1c7cf293eaea8a59dab906e4f2), [`2cf5cfc`](https://github.com/enboxorg/enbox/commit/2cf5cfcaf8046fe4895233e45ff5760e083bf6bc)]:
  - @enbox/dwn-clients@0.4.30
  - @enbox/dids@0.1.10
  - @enbox/connect@0.1.19
  - @enbox/dwn-sdk-js@0.4.23

## 0.8.38

### Patch Changes

- Updated dependencies [[`2eee007`](https://github.com/enboxorg/enbox/commit/2eee007892807d44dad8ce828afe19aee7dfe18d)]:
  - @enbox/dwn-sdk-js@0.4.22
  - @enbox/connect@0.1.18
  - @enbox/dwn-clients@0.4.29

## 0.8.37

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
  - @enbox/common@0.1.6
  - @enbox/dwn-sdk-js@0.4.21
  - @enbox/connect@0.1.17
  - @enbox/crypto@0.1.9
  - @enbox/dids@0.1.9
  - @enbox/dwn-clients@0.4.28

## 0.8.36

### Patch Changes

- [#1503](https://github.com/enboxorg/enbox/pull/1503) [`87129bd`](https://github.com/enboxorg/enbox/commit/87129bd86cd1c3a0c0c7d288407f063e3ef5a030) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Resolve delegated write authorization internally when repairing role-audience key delivery.

- [#1506](https://github.com/enboxorg/enbox/pull/1506) [`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Run role-audience delivery reconciliation and bounded transient retries in the background for each encrypted-role protocol used by an Enbox session. Work waits for a current reachable replica and wakes on startup, relevant role changes, connectivity recovery, and recipient protocol installation without delaying connection readiness or accepted writes.

- [#1505](https://github.com/enboxorg/enbox/pull/1505) [`41ce181`](https://github.com/enboxorg/enbox/commit/41ce181a981b17cc82d50bc496b0a2cab97df820) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Persist an internal, reconstructable audience-key delivery projection for locally accepted role records so initial delivery outcomes survive agent restarts without becoming a second membership authority. This is the storage foundation for role-record reconciliation and restart-safe retry tracked by #1092.

- [#1504](https://github.com/enboxorg/enbox/pull/1504) [`cf909fd`](https://github.com/enboxorg/enbox/commit/cf909fd4f6394d81e87e0a24d6f46ea1bb76a1a1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Classify audience-key delivery failures for durable retry and recipient-install handling.

- [#1499](https://github.com/enboxorg/enbox/pull/1499) [`cb112bc`](https://github.com/enboxorg/enbox/commit/cb112bcbc0b4e0f545ad5852a6c5fcd10fd0103b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix encrypted nested record updates resolving a shallow role-audience context, which reminted keys and backdated the operation.

- [#1506](https://github.com/enboxorg/enbox/pull/1506) [`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Reconstruct the internal audience-key delivery projection from complete encrypted role-record feeds, including delegated scans, so missing active roles become pending and deleted roles no longer remain scheduled as tracked by #1092.

- [#1508](https://github.com/enboxorg/enbox/pull/1508) [`16b7cbc`](https://github.com/enboxorg/enbox/commit/16b7cbc5e7d5f69dc0b87738c0cc6e69951ce649) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Expose persisted audience-key delivery state and coordinator-backed retry through typed role records. Remove raw status verification and routine update-side delivery; retain supplied-key updates for out-of-band recovery.

- Updated dependencies [[`e6b1c06`](https://github.com/enboxorg/enbox/commit/e6b1c0636c3c63a9fba2dd154db38f147358c460)]:
  - @enbox/dwn-sdk-js@0.4.20
  - @enbox/connect@0.1.16
  - @enbox/dwn-clients@0.4.27

## 0.8.35

### Patch Changes

- [#1476](https://github.com/enboxorg/enbox/pull/1476) [`00dafdf`](https://github.com/enboxorg/enbox/commit/00dafdf88c517df248639680dc89616e9f42616d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Authenticate protocol configurations used for remote encryption-policy resolution and record artifacts returned through app-facing remote query, read, and initial subscription snapshot calls, bind record results to the original request filter, and verify inline or streamed record bytes against their signed CID and size. Remote protocol definitions used for encryption policy must now be signed directly by the target DID. Anonymous subscriptions now use the current transport request shape, and lazy read-only records reject data from a different record version.

  These checks authenticate returned artifacts; they do not prove result completeness or freshness because DWN query replies do not yet carry a tenant-authenticated state commitment. `RecordsCount` replies carry no signed artifacts, so their aggregate values remain assertions by the remote DWN. Initial `RecordsSubscribe` snapshots are verified, but subsequent live events remain outside this response-verification boundary.

  Streamed reads are authenticated at successful end-of-stream, so callers can observe chunks before the final CID check completes. Integrity-sensitive consumers that cannot tolerate an unauthenticated prefix must buffer the stream through successful completion before using its bytes.

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

- [#1498](https://github.com/enboxorg/enbox/pull/1498) [`659372d`](https://github.com/enboxorg/enbox/commit/659372de22c2cf7481fa4d28ba2b6380483e93a4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add an isolated, real local-DWN test context under `@enbox/api/testing` and support network-free identities in the agent test harness.

- Updated dependencies [[`00dafdf`](https://github.com/enboxorg/enbox/commit/00dafdf88c517df248639680dc89616e9f42616d), [`2a4223a`](https://github.com/enboxorg/enbox/commit/2a4223a8255c7c9c6efc1245021fd620f11902ba), [`9511e65`](https://github.com/enboxorg/enbox/commit/9511e6566d92bb7b89e8c35fe3f0602c3a313e4b), [`d257e04`](https://github.com/enboxorg/enbox/commit/d257e04b5001f596d28691c942ca5d0bf25c2c22), [`8b0dc99`](https://github.com/enboxorg/enbox/commit/8b0dc99476d7981a2f2bd97fabbf0ecbe4754d33)]:
  - @enbox/dwn-sdk-js@0.4.19
  - @enbox/connect@0.1.15
  - @enbox/dwn-clients@0.4.26

## 0.8.34

### Patch Changes

- [#1449](https://github.com/enboxorg/enbox/pull/1449) [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: use one source-parameterized operation to collect durable feed inventories for reconciliation and quota analysis

- [#1449](https://github.com/enboxorg/enbox/pull/1449) [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: make sync convergence and connectivity managers explicit coordinator dependencies and remove forwarding adapters

- Updated dependencies [[`f8a7ff1`](https://github.com/enboxorg/enbox/commit/f8a7ff1f9a40af66e1bdeb313e1131d7cbe12a48), [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c)]:
  - @enbox/dwn-sdk-js@0.4.18
  - @enbox/connect@0.1.14
  - @enbox/dwn-clients@0.4.25

## 0.8.33

### Patch Changes

- [#1407](https://github.com/enboxorg/enbox/pull/1407) [`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: add safe, deadline-bounded sync teardown and identity lifecycle waits

  The existing `stopSync()` numeric timeout keeps its legacy coercion for
  non-finite values, but its default two-second budget now also bounds transport
  subscription closure. The new lifecycle option objects reject invalid timeout
  values before changing state.

  Stopping invalidates callbacks and clears in-memory runtime ownership before
  closing remote and local subscriptions concurrently. An unfinished transport
  close remains tracked across retries, so a later lifecycle call cannot report
  success until the original cleanup settles.

- [#1429](https://github.com/enboxorg/enbox/pull/1429) [`f804103`](https://github.com/enboxorg/enbox/commit/f80410366f4e3798018618f2f15ed014fd3796e8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add one protocol-derived `RecordQuery` shared by typed record queries and counts, including exact path tag and data-format types. Add authenticated `DwnApi.records.count()`, preserve query/count population parity, and expose the canonical query and count-response types from browser builds. Published-date filters and sorting explicitly select published records for both operations.

  Remove the overlapping typed query aliases, `queryAll()` drains, Repository facade, and high-level subscription models. Typed records now have one query/count contract, explicit create/update operations, and no client-side upsert or parallel collection abstraction. Callers page explicitly through `query()` with its returned cursor.

  Flatten advanced RecordsSubscribe and MessagesSubscribe to their raw DWN contract: a required subscription handler and the unmodified protocol reply. Remove `LiveQuery`, `TypedLiveQuery`, `MessagesLiveQuery`, record hydration, and `includeRecords`; a later observed-view API will be the sole high-level reactive model. Use `filter.contextId` for typed child selection; protocol identity and the exact-parent fence are derived internally. These intentional breaking changes remove the superseded exports from API, browser, and CLI without compatibility aliases.

  Resolve delegated record-read grants from the wire filter as the single protocol source, reject empty typed context IDs, and surface permission-store failures instead of silently treating them as missing grants. Delegated permission lookup now reuses a bounded grant catalog across record contexts while matching each requested scope independently.

  Resolve delegated record writes and deletes against their protocol path and context instead of selecting protocol-wide grants only. Permission lookups now reuse cached catalogs by default and expose `forceRefresh` for an explicit store refresh, while a scope miss refreshes the store so newly imported grants are immediately visible.

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

- [#1405](https://github.com/enboxorg/enbox/pull/1405) [`7a6abfd`](https://github.com/enboxorg/enbox/commit/7a6abfd92ca2cb019f5a7aa5260d12d06c59ce8d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: retry live-sync link initialization while a newly created tenant is still registering

  A freshly created identity's remote DWN briefly rejects `MessagesSubscribe` with `401 Not a registered tenant` until tenant registration lands there. This transient 401 is now classified like `did:dht` propagation lag: the link re-initializes on the short backoff ladder (`isTransientInitFailure`) and logs at `warn` rather than retiring the link with an alarming `error` and waiting for the periodic (5-minute) settle check. Because the pull subscription opens before the baseline push, retrying also unblocks the initial push of records written during identity creation (e.g. a new profile), so they reach the remote without waiting for the next settle pass or an app restart.

- [#1448](https://github.com/enboxorg/enbox/pull/1448) [`713c757`](https://github.com/enboxorg/enbox/commit/713c7577c2ece2f59929f5f226abdf6cf40a7e1c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: keep durable-feed reconciliation results limited to state that their callers consume, without changing sync behavior

- Updated dependencies [[`ca04167`](https://github.com/enboxorg/enbox/commit/ca04167e6e6e61eea56eedd5eb7acbc3b909fd4c), [`23d84a4`](https://github.com/enboxorg/enbox/commit/23d84a4cd94d169423d9fbe5c84b5e7bd803b134), [`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774), [`50c40fd`](https://github.com/enboxorg/enbox/commit/50c40fd50950d5a25c0d5c342f55b078adf247e9)]:
  - @enbox/common@0.1.5
  - @enbox/dwn-sdk-js@0.4.17
  - @enbox/connect@0.1.13
  - @enbox/crypto@0.1.8
  - @enbox/dids@0.1.8
  - @enbox/dwn-clients@0.4.24

## 0.8.32

### Patch Changes

- [#1392](https://github.com/enboxorg/enbox/pull/1392) [`4043f46`](https://github.com/enboxorg/enbox/commit/4043f46136cf23f08eb092976f1cb12cbb600ca7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: make each active link controller the authoritative replication session

  Active reconciliation, subscriptions, recovery, and checkpoint commits now
  share one controller-owned link object and mailbox. Replication-link storage
  serializes read/merge/write mutations across browser contexts so stale link
  copies cannot overwrite newer durable state.

- [#1401](https://github.com/enboxorg/enbox/pull/1401) [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Bound repair churn during repeated subscription flapping by deferring superseding repair signals through the per-link retry backoff without consuming the failure-attempt budget.

- [#1394](https://github.com/enboxorg/enbox/pull/1394) [`61ceb57`](https://github.com/enboxorg/enbox/commit/61ceb575144c0eea39cee6938ce2f2c474c8b6f2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: align sync implementation, tests, and architecture documentation on canonical replication terminology

- [#1399](https://github.com/enboxorg/enbox/pull/1399) [`64115f8`](https://github.com/enboxorg/enbox/commit/64115f8d9fbfb37bf16cb04603556a0873de6b53) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Simplify sync quota plumbing by injecting `SyncQuotaManager` directly into durable-feed policy consumers while retaining engine-owned lifecycle fencing for probes.

- [#1395](https://github.com/enboxorg/enbox/pull/1395) [`4426e72`](https://github.com/enboxorg/enbox/commit/4426e72a213fffbf420ce776fb2adb31c9c4f9b3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: treat remote subscription events as cursorless durable pull wakes

  Pull and push subscriptions now have the same progress model: their events only coalesce work, while `MessagesQuery` resumes from the persisted direction checkpoint and advances it after a settled page. Matching subscription snapshots establish a paired startup baseline; reconnect wakes both durable directions to cover the disconnected interval. Pull admission reuses message and inline-data bytes returned by the durable query, verifies immediate push echoes against local stored state before avoiding remote hydration, and emits one described `delivery:applied` event for each fresh root or dependency. Event cursors, EOSE commits, subscription-gap repair state, and the separate live-pull admission pipeline are removed.

  Dependency-blocked pull pages retain their checkpoint and retry on the next subscription wake or periodic settle pass instead of entering a fixed-delay verified-reconciliation loop.

  The public `SyncEvent` members `reconcile:applied` and `gap:detected` are removed; consumers should observe `delivery:applied` as the single notification for each freshly admitted remote message.

- [#1389](https://github.com/enboxorg/enbox/pull/1389) [`82e2f62`](https://github.com/enboxorg/enbox/commit/82e2f628fd6441eb4ca81be0b13952d11fbe6cba) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: make live push a coalesced durable-feed wake

  Local subscription events now wake one coalesced durable push pass instead of creating in-memory batches or delivery acknowledgements. Every pass resumes from the persisted push checkpoint, and advances it only after a complete feed page is pushed successfully. Retryable failures leave the cursor unchanged so startup, reconnect, or a later wake deterministically replays the owed page. Retryable live-push failures now enter verified reconciliation after five seconds instead of using the removed in-memory 0/250ms/1s/2s retry ladder. Remotely sourced CIDs are marked before local application emits its wake, preventing an immediate echo to the same DWN.

- [#1396](https://github.com/enboxorg/enbox/pull/1396) [`a0aa94e`](https://github.com/enboxorg/enbox/commit/a0aa94e727320063dbb806aab57979abbbfb82b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace the sync link mailbox, directional queues, and readiness promise with one ordered executor. Wake signals remain coalesced and durable-checkpoint-driven, repair keeps priority without discarding ordinary work, and administrative sync calls abort promptly while a link baseline is unavailable.

  Repair attempts superseded by a newer repair signal are retired from the bounded failure count, so later genuine failures retain the complete retry ladder and their reported attempt number may restart after supersession.

- [#1393](https://github.com/enboxorg/enbox/pull/1393) [`c603c33`](https://github.com/enboxorg/enbox/commit/c603c333387644b2d250cc4e778be1ebb14581ff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: order replication startup and settle work per link

  Pull and push callbacks now enter independent FIFO replay queues behind one generation-owned readiness barrier. Subscription snapshots or an initial durable reconciliation establish both baselines before callbacks run; resets fence queued work and stale completions. Recovery and settle passes coordinate through the same authoritative replication session while allowing the two replay directions to make progress independently. Administrative sync and settle work skip initializing or repairing links instead of waiting behind their readiness barriers; the in-flight baseline or repair already owns reconciliation for those links.

- [#1401](https://github.com/enboxorg/enbox/pull/1401) [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Re-sign remote-mode local DWN subscriptions at their reconnect cursor, replay durable push progress after reconnection, and repair subscriptions whose transport recovery fails.

- [#1398](https://github.com/enboxorg/enbox/pull/1398) [`87afa05`](https://github.com/enboxorg/enbox/commit/87afa055a2aa23e7981f83dbff1ff2add138ea94) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Move sync repair and reconciliation into runtime-owned link scheduling. Per-link retries now share keyed stale-callback fencing, earliest-wins reconciliation timing, and automatic cancellation on runtime disposal or link removal.

- [#1387](https://github.com/enboxorg/enbox/pull/1387) [`4062e4a`](https://github.com/enboxorg/enbox/commit/4062e4ab7e588c11a7f2fcfe302ac5cf048e4624) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: keep ordinary DWN requests on their endpoint's native transport

  `EnboxRpcClient.sendDwnRequest` routes HTTP(S) requests over HTTP(S), where
  the server advertises complete `dwn.processMessage` behavior. Subscriptions
  continue to map HTTP(S) endpoints to the pooled WebSocket transport, and an
  explicit `ws:`/`wss:` endpoint continues to use that transport directly.
  This removes a second routing policy based on transient socket health and
  keeps request transport selection deterministic.

- [#1386](https://github.com/enboxorg/enbox/pull/1386) [`686c918`](https://github.com/enboxorg/enbox/commit/686c918e33d11af23314a2be421d3b66028020a1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: make browser wake recovery transport-owned

  Browser online and visibility signals now stay in the WebSocket transport,
  which probes connection health, reconnects, and resumes subscriptions from
  their durable cursors. The agent no longer maintains a second wake debounce
  and recovery state machine or starts data-plane reconciliation from those
  signals. If WebSocket subscriptions cannot operate while HTTP still can, or a
  target does not yet have an active link, recovery falls back to the periodic
  settle check (the configured sync interval, `5m` by default).

  Link connectivity now means transport-observed connectivity rather than the
  browser's network hint. While an active page is offline, the default heartbeat
  detects the lost socket within one 30-second interval plus its 10-second pong
  deadline; a foreground/online wake instead runs the transport's 5-second
  on-demand health probe immediately.

- [#1388](https://github.com/enboxorg/enbox/pull/1388) [`7a437b2`](https://github.com/enboxorg/enbox/commit/7a437b2bed8cdb88b30eec86fb6420801845a352) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: subscribe-reply feed snapshot and empty-log anchor cursor

  MessagesSubscribe replies now carry the tenant feed's `head` progress token and scope `fingerprint`, observed after the subscription is active. Empty replication logs return a position-zero anchor cursor from `logRead` in both stores, so empty-feed drains checkpoint instead of re-enumerating every pass. The agent captures both subscription snapshots: matching fingerprints atomically establish the pull and push baselines from their respective heads, while missing or mismatched snapshots run one durable reconciliation before queued callbacks are released.

- [#1400](https://github.com/enboxorg/enbox/pull/1400) [`06793a4`](https://github.com/enboxorg/enbox/commit/06793a4ddb8577b6f73c59db001e89fa2499f18c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Recover sync directions with corrupt persisted checkpoints by resetting invalid progress tokens before querying durable feeds.

- Updated dependencies [[`4062e4a`](https://github.com/enboxorg/enbox/commit/4062e4ab7e588c11a7f2fcfe302ac5cf048e4624), [`7a437b2`](https://github.com/enboxorg/enbox/commit/7a437b2bed8cdb88b30eec86fb6420801845a352)]:
  - @enbox/dwn-clients@0.4.23
  - @enbox/dwn-sdk-js@0.4.16
  - @enbox/connect@0.1.12

## 0.8.31

### Patch Changes

- [#1382](https://github.com/enboxorg/enbox/pull/1382) [`bad337e`](https://github.com/enboxorg/enbox/commit/bad337e27a7f5e1029780401a419bc5c313c03ff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Keep low-level record reads, queries, subscriptions, and writes on the raw bytes stored by the DWN, and lazily decrypt the application view from each RecordsWrite encryption envelope. Decryption failures now surface when `record.data` is consumed instead of failing the containing read, query, or subscription.

- [#1383](https://github.com/enboxorg/enbox/pull/1383) [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Make protocol definitions the sole source of record encryption policy and remove caller-controlled encryption switches. Reject records whose stored representation does not match their type policy, prevent used paths from changing representation under the same protocol URI, and separate encrypted `grantKey` records from plaintext `wrappedGrantKey` envelopes in the core encryption protocol.

- [#1380](https://github.com/enboxorg/enbox/pull/1380) [`6688e32`](https://github.com/enboxorg/enbox/commit/6688e327e27d52a55d6daabdcfe1195f2954a67a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Reject raw RecordsWrite payloads whose CID or size does not match the signed message before local processing or remote transmission. One-shot streams are currently validated over the whole payload before dispatch so plaintext can never leave under a ciphertext-committing message; a later stored-byte streaming pass can make this incremental without exposing plaintext.

- Updated dependencies [[`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3)]:
  - @enbox/dwn-sdk-js@0.4.15
  - @enbox/connect@0.1.11
  - @enbox/dwn-clients@0.4.22

## 0.8.30

### Patch Changes

- [#1372](https://github.com/enboxorg/enbox/pull/1372) [`257fa11`](https://github.com/enboxorg/enbox/commit/257fa11e014b59a758e93dcdeb8dec9b6deb989b) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: live pull serves inline record data from the subscription event instead of re-fetching it

- [#1373](https://github.com/enboxorg/enbox/pull/1373) [`da812fc`](https://github.com/enboxorg/enbox/commit/da812fcfd501f4135682683f2960793c0ad37d26) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: the sync engine is live-only — poll mode removed. startSync starts live sync; `interval` now sets the periodic settle-check cadence. Userland polling remains trivial via the public one-shot sync(): setInterval(() => { agent.sync.sync().catch(console.error); }, ms).

- [#1371](https://github.com/enboxorg/enbox/pull/1371) [`83020bd`](https://github.com/enboxorg/enbox/commit/83020bdcf86e4db86f00f877c88427fc7e36f7bc) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: greenfield cleanup of the sync engine — remove backwards-compatibility shims, dead status/config surface, and duplicated helpers; no behavior changes on reachable paths. `startSync` now requires an explicit `mode`, the write-only `receivedToken` checkpoint field is gone, and a checkpoint update can no longer recreate a deleted replication-link record.

- [#1367](https://github.com/enboxorg/enbox/pull/1367) [`8b9ab70`](https://github.com/enboxorg/enbox/commit/8b9ab7017d5ac9d37920249c54d75264cad1fe99) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor(agent): serialize the live-push regime through a per-link mailbox

  `SyncLinkController` gains a mailbox — a FIFO `enqueue` serializing link-scoped work for the controller's lifetime, refusing work after deactivation while letting in-flight operations finish, with rejections surfaced to callers without poisoning the queue. The push regime's read-decide-write bodies (flush and requeue) run through it, so at most one push flush is in flight per link _by construction_: the push-specific `flushing` flag is deleted, `takeBatch` is controller-addressed, and a reconcile requeue serializes behind an in-flight transport batch instead of interleaving with it — removing a source of duplicate re-push work. Local subscription events still append synchronously (ingestion never blocks behind a network push); the start-flush decision reads the generalized `mailboxIdle` signal. First mailbox migration of the Phase-3 per-link-actor series; repair/reconcile and live-pull ordinals follow.

- [#1374](https://github.com/enboxorg/enbox/pull/1374) [`3804b5d`](https://github.com/enboxorg/enbox/commit/3804b5dc1ddb94cd7beaff7045345efd474f6965) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: sync engine readability and vocabulary. Corrected stale and inverted comments, removed dead bookkeeping, split the 244-line engine constructor into named factories, and unified the subsystem vocabulary to one name per concept and one meaning per word (glossary in `docs/architecture/sync-vocabulary.md`).

  BREAKING: the `SyncEngine` dead-letter read API is renamed to match the `DeadLetterEntry` type it returns and the vocabulary the store and every collaborator already used — `getFailedMessages` → `getDeadLetters`, `clearFailedMessage` → `clearDeadLetter`, `clearAllFailedMessages` → `clearAllDeadLetters`.

  Fixed: a paused replication link reported `converged: true` from a reconcile cycle that compared nothing, so post-repair verification could emit `reconcile:completed` for a link it never checked. The reconcile result now carries `paused` and leaves `converged` absent when nothing was verified.

- [#1370](https://github.com/enboxorg/enbox/pull/1370) [`b334497`](https://github.com/enboxorg/enbox/commit/b33449751d36dd5c3bfddce7d208c75a9418bf50) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: one generation owns a link's pull deliveries and subscription pair

  Live pull keeps its concurrent delivery model (handlers fire without
  awaiting; an ordinal tracker advances the checkpoint over the
  contiguously committed prefix), and a single per-link generation now
  fences everything transient around it. Pausing, repairing, or resetting
  a link bumps the generation synchronously, before any await, and:

  - deliveries carry a generation ticket, so one still admitting across a
    repair cannot collide with a reissued ordinal and mark durable
    progress over a message that never applied;
  - out-of-scope events acknowledge through the ordinal tracker instead
    of directly persisting their cursor, so they cannot skip past an
    earlier covered delivery still admitting;
  - one generation is captured for the whole subscription pair: both
    opener halves validate it after every await and attach through a
    generation-fenced install, a pause landing between the halves stops
    the attempt before the local half opens, a pause or repair landing
    while an open is in flight closes the returned subscription instead
    of installing a permanently fenced slot, a stale ProgressGap or
    rejection is that attempt's teardown rather than a fresh failure,
    completing initialization cannot mark a paused link live, and a link
    paused or taken over for repair while opening stays in its identity's
    keep-set instead of being failed and pruned;
  - cleanup is attempt-owned: a superseded opener no longer closes the
    replacement generation's subscription pair;
  - callbacks and processing rejections from a superseded subscription —
    remote pull and local push alike — are discarded silently instead of
    writing checkpoints, enqueueing redundant pushes, spamming error
    reports, or re-triggering repair on a healthy link.

- [#1369](https://github.com/enboxorg/enbox/pull/1369) [`08c6912`](https://github.com/enboxorg/enbox/commit/08c69121ecdfcfe2adc7758e7242d28b894caa95) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: serialize link repair and reconciliation through the per-link mailbox

  Repair and durable-reconciliation passes now run on the same per-link
  mailbox that serializes live-push flushes, with three ownership rules
  replacing the old scattered in-flight bookkeeping:

  - Shared lanes with trailing turns: concurrent repair or reconcile
    requests coalesce onto one execution, and a request arriving while a
    pass is already executing (a fresh gap with a newer resume token, a
    signal postdating the pass's remote snapshot) runs exactly one
    trailing pass — enqueued as a new mailbox turn behind already-queued
    work, never inline. A superseded repair pass does not complete, clear
    progress, or mark the link live over the newer request, and a
    requested trailing pass subsumes the failed pass's retry timer. The
    `repairInFlight`/`reconcileInFlight` handles are gone.
  - Transitions publish atomically: a repair transition writes its resume
    token, run request, generation fence, and in-memory status in one
    synchronous block before any await, so a pass consuming the request —
    trailing turn or fresh supervision — always observes the complete
    transition, and a superseded pass's failure hands off quietly to the
    trailing repair instead of reporting, arming retries, or burning the
    attempt budget into a pause.
  - Pause is a cancellation fence: pausing stays prompt and mailbox-free
    (it is the fail-safe for revoked authorization), and every repair
    checkpoint, completion step, and late failure handler observes the
    paused status and abandons the link instead of reviving it, reporting
    spurious errors, or rearming timers.
  - Push batches die with their runtime: an in-flight push result or
    rejection that lands after a pause or runtime replacement is dropped
    instead of folding transitions, requeueing entries, or recreating the
    runtime the transition just cleared.

  Local event ingestion stays synchronous, and events observed while a
  repair or reconcile occupies the mailbox queue a flush behind it rather
  than stalling until the next event arrives.

## 0.8.29

### Patch Changes

- [#1365](https://github.com/enboxorg/enbox/pull/1365) [`9dd09a6`](https://github.com/enboxorg/enbox/commit/9dd09a6d76a98eb54da813b1a3dc9b648527f7f3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: coalesce browser connectivity recovery signals before running full integrity checks

- [#1362](https://github.com/enboxorg/enbox/pull/1362) [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: lossless subscription-decrypt backpressure with acks gated on consumer completion

  The decrypting subscription wrapper returns each event's completion promise — now covering decryption AND the consumer's own (possibly async) processing — and the WebSocket client acks each event, and advances its reconnect cursor, only after that completion resolves, in delivery order. If more than 256 events queue behind in-flight decryption the wrapper terminates losslessly: the overflowing and all later events reject with the new `SubscriptionHandlerTerminalError`, which the WebSocket transport honors by closing the tracked subscription and withholding their acks and cursor advancement, while the consumer receives a synthetic `SubscriptionDecryptBackpressureExceeded` error carrying the last successfully delivered cursor — resubscribing from it replays every dropped event. `SubscriptionListener` and `DwnSubscriptionHandler` now explicitly permit `void | Promise<void>`, and every handler invocation — event delivery and transport lifecycle notifications alike — is normalized through a promise chain: a synchronous throw becomes an observed rejection instead of escaping the socket dispatch or skipping other subscriptions' notifications. `@enbox/browser` also re-exports `AudienceDecryptError`, `AudienceDecryptFailureCause`, and `AudienceKeyDeliveryOutcome` so browser-only apps can classify decrypt failures and delivery outcomes without importing `@enbox/api` directly.

- Updated dependencies [[`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca), [`535922a`](https://github.com/enboxorg/enbox/commit/535922a5c7c4312bac6155cfa34cff38bf458080)]:
  - @enbox/dwn-clients@0.4.21
  - @enbox/dwn-sdk-js@0.4.14
  - @enbox/connect@0.1.10

## 0.8.28

### Patch Changes

- [#1350](https://github.com/enboxorg/enbox/pull/1350) [`c4ee0bc`](https://github.com/enboxorg/enbox/commit/c4ee0bc057fb5b2278926fe1d9d1add618acc08d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(agent): typed error taxonomy for recipient-side role-audience decrypt failures

  Recipient-side decrypt failures now throw `AudienceDecryptError` carrying a machine-readable
  `cause` (`'not-wrapped-for-role' | 'delivery-missing' | 'role-not-held' | 'audience-superseded' |
'remote-unverifiable' | 'unknown'`) plus `recordId`, `protocol`, `recipientDid`, and a `detail`
  string, instead of one generic prose error with the real cause swallowed by logging. Previously
  logger-only observations (rejected role-holder verification, skipped grantKeys, unreachable-remote
  lookups) are folded into the error data. `@enbox/api` re-exports the class and cause type so apps
  can catch it from record data rejections.

- [#1344](https://github.com/enboxorg/enbox/pull/1344) [`6ad8f08`](https://github.com/enboxorg/enbox/commit/6ad8f08b2b87a9915ddbc6b289284a2b6635fbbd) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(agent): audience key delivery status and re-provision primitives

  Adds two public `AgentDwnApi` primitives for role-audience key delivery so apps no longer hand-roll `$encryption/delivery` queries or touch-update `$role` records to force re-delivery:

  - `getAudienceKeyDeliveryStatus` — resolves whether a delivery record wraps the CURRENT audience key of a tuple to a recipient (`delivered` / `not-delivered` / `unverifiable`). Matches deliveries on the current audience `keyId` (a stale delivery of a superseded key no longer reads as delivered) and short-circuits to `unverifiable` for delegate contexts, whose view of third-party deliveries is structurally visibility-filtered.
  - `reprovisionAudienceKeyDelivery` — provisions the current audience key delivery for one recipient without touching the `$role` record. Skips the write when the current key is already delivered (`alreadyDelivered: true`), otherwise resolves/mints the audience under the usual seal-coverage rules and writes the delivery, reporting failures best-effort as `{ delivered: false, reason }`.

  Also updates stale pre-best-effort doc comments on `ProcessDwnRequest.recipientRolePublicKey`, `AudienceKeyDeliveryOutcome`, and `DwnResponse.audienceKeyDelivery` to match the reporting semantics (only pre-write validation throws).

- [#1299](https://github.com/enboxorg/enbox/pull/1299) [`16c8ea4`](https://github.com/enboxorg/enbox/commit/16c8ea46380d303fb20eeec7047b5f1f286f661f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Extract registered sync target planning and cache generation into a backend-neutral planner while preserving existing resolution and invalidation behavior.

- [#1305](https://github.com/enboxorg/enbox/pull/1305) [`3e6d5fe`](https://github.com/enboxorg/enbox/commit/3e6d5fe51f3ae16db0c08174132bcdc828f15c93) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Isolate durable message-feed reconciliation, inventory comparison, and checkpoint progression in a backend-neutral coordinator.

- [#1333](https://github.com/enboxorg/enbox/pull/1333) [`e83cb4b`](https://github.com/enboxorg/enbox/commit/e83cb4b05e7f184e515ccd547f5ac1c346fea045) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Decompose live pull processing, push batching, and per-link recovery into backend-neutral coordinators while preserving sync lifecycle and stale-callback guarantees.

- [#1323](https://github.com/enboxorg/enbox/pull/1323) [`f41a755`](https://github.com/enboxorg/enbox/commit/f41a755adfe769ad1ca5b00b7275059f2ed2305e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: isolate sync echo-loop suppression in a backend-neutral component

- [#1294](https://github.com/enboxorg/enbox/pull/1294) [`73a76e1`](https://github.com/enboxorg/enbox/commit/73a76e1099ebfb6b8e399431541a43d14d3df5ec) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Refactor sync identity registration persistence behind a backend-neutral store contract while preserving the existing Level data format and sync behavior.

- [#1300](https://github.com/enboxorg/enbox/pull/1300) [`8f6cc7d`](https://github.com/enboxorg/enbox/commit/8f6cc7de740771a15a7eb1732d0597b2082fb347) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Isolate sync lifecycle ordering and background task supervision in a backend-neutral coordinator.

- [#1309](https://github.com/enboxorg/enbox/pull/1309) [`d5c8e83`](https://github.com/enboxorg/enbox/commit/d5c8e8300ffb30ba89580ea0a37c3f9513470572) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Extract durable sync quota lifecycle and persistence behind backend-neutral manager and store contracts while preserving the existing Level data format and retry behavior.

- [#1327](https://github.com/enboxorg/enbox/pull/1327) [`3309d87`](https://github.com/enboxorg/enbox/commit/3309d87efdea35ca784917b3b0ec05362a4a7c81) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Refactor one-shot sync run coordination into a backend-neutral component.

- [#1314](https://github.com/enboxorg/enbox/pull/1314) [`7f4c4e7`](https://github.com/enboxorg/enbox/commit/7f4c4e7b485f47b8cf0d6c40d60054363f4c56e3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Extract sync scope-closure validation and retained protocol-history traversal behind backend-neutral operations while preserving registration behavior.

- [#1321](https://github.com/enboxorg/enbox/pull/1321) [`a40eb11`](https://github.com/enboxorg/enbox/commit/a40eb11831bd9e669ed1a6b5dca58274be82d9de) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: isolate backend-neutral sync health and remote-status aggregation

- [#1297](https://github.com/enboxorg/enbox/pull/1297) [`e33cf82`](https://github.com/enboxorg/enbox/commit/e33cf820fec511d09676f5ea5473fa6db8727c5f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Extract sync endpoint and authorization resolution into a backend-neutral target resolver while preserving existing target and cache behavior.

- [#1337](https://github.com/enboxorg/enbox/pull/1337) [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(dwn-sdk-js): BroadcastChannel-bridged event-log wakes for sibling contexts

  New `BroadcastChannelWakePublisher` fans each store wake out to in-process listeners and mirrors it over a named `BroadcastChannel`, so sibling execution contexts sharing one underlying store (browser tabs, workers, a SharedWorker over the same IndexedDB) observe each other's commits immediately instead of waiting for the durable event log's idle re-drain (~30s). Wakes received from the channel are never re-posted (no loops), non-wake traffic is ignored, and environments without `BroadcastChannel` degrade to in-process-only delivery.

  The agent's default message log now derives a channel name from the store location, so local subscriptions in one tab fire promptly when another tab (or a worker) writes — including writes applied by sync running in a different context.

- [#1319](https://github.com/enboxorg/enbox/pull/1319) [`757cff1`](https://github.com/enboxorg/enbox/commit/757cff17cbb8bec36f806eec1a8ee3606f3c9ae2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: isolate dead-letter and deferred-pull persistence behind backend-neutral store contracts

- [#1324](https://github.com/enboxorg/enbox/pull/1324) [`2b50952`](https://github.com/enboxorg/enbox/commit/2b5095252fc621d6ea35db5a330759009c2a88e2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: isolate sync connectivity and browser recovery coordination

- [#1283](https://github.com/enboxorg/enbox/pull/1283) [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(agent): graceful, self-healing handling of quota-blocked sync pushes + observable per-remote sync status

  Sync pushes rejected for tenant storage/message quota are no longer retried forever (the console-error flood that spun the remote). They are now detected precisely (`isQuotaExceededError`, newly exported from `@enbox/dwn-clients`) and deferred on a per-link, per-message exponential-backoff probe. Feed checkpoints may advance past the explicit omission, so a blocked message neither stalls newer records nor prevents other remotes from progressing; due and manual retries target the omitted CID independently of that checkpoint. If a later update or tombstone makes the old bytes unreachable, its acknowledgement converts the block into a resolved per-link omission: it is healthy, never retried, and remains durable only long enough to explain the intentional feed-CID difference.

  Live sync now suppresses the remote subscription echo of messages already materialized in the same local tenant when it pushes them to that endpoint. The matching pull delivery still advances its durable checkpoint, but it no longer performs a redundant remote `MessagesRead` or re-applies data already present in the local DWN; tenant- and endpoint-scoped tracking preserves multi-identity isolation and normal multi-provider fan-out. Canonicalized bootstrap messages that may not exist in the destination tenant still follow normal pull admission. Pull deliveries accepted while a link is still initializing are also committed, preventing an early event from pinning every later checkpoint behind an unfinished ordinal.

  Replicated metadata-only historical writes continue through storage-quota preflight without charging their declared payload size, while message-count quota and all normal data-bearing quota checks remain enforced. This lets a later tombstone or smaller update replay its retained initial-write dependency without exposing a dataless current record. Same-CID data retries against ancestry-only storage are deferred instead of falsely acknowledged, embedded message data is rejected in favor of the validated transport field, and storage reporting now counts only latest base-state data rather than metadata-only history.

  New observability, re-exported through `@enbox/browser` for dapp "remotes" panels: `SyncEngine.getRemoteSyncStatus()` returns a per-`(tenant, remote)` snapshot (`healthy | quota-blocked | degraded | offline`, blocked count, next-probe time, last error/activity); `SyncEngine.retryRemoteNow()` directly re-probes only the selected remote; `push:quota-blocked` / `push:quota-cleared` events include durable timing and clear resolution; and `SyncHealthSummary` gains `quotaBlockedMessageCount`.

  Also fixes a latent bug in the push dependency-fetch path: the four local dependency queries (`fetchProtocolConfig`, `fetchRecordsByRecordId`, `fetchRoleRecord`, `fetchRecordData`) passed `store: false`, which makes `AgentDwnApi.processRequest` short-circuit to a synthetic `202` reply with no entries instead of executing the query — so every attempt to satisfy a remote `Incomplete` missing-dependency from the local DWN silently returned `failed`. Dropping `store: false` lets those local queries run (read/query handlers persist nothing, so there is no side effect). The bug was masked because unit tests stub `processRequest`; the added live-sync/quota convergence coverage now exercises the real path.

- [#1315](https://github.com/enboxorg/enbox/pull/1315) [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity across smaller packages (Sonar S3776)

  Behavior-preserving extract-method refactoring of 12 functions (CC 16–29) to the ≤15
  threshold, across five packages:

  - **agent** — DID-resolver-cache `get`, three connect-protocol-preparation functions,
    `AgentDwnApi.sendDwnRpcRequest`, and two `dwn-encryption` reply/decrypter functions.
  - **dids** — `did-dht-dns` `fromDnsPacket` / `toDnsPacket`.
  - **connect** — relay transport `awaitResponse`.
  - **dwn-clients** — `sendDwnRequest` body parsing.
  - **dwn-sql-store** — `processFilter` range handling.

  Each extraction lifts a contiguous block into a named helper called at the same point.
  The boolean transforms (De Morgan negations in `dwn-encryption.maybeDecryptReply`,
  guard inversions, and one loop `continue`→`return`) were each verified algebraically
  exact, so record decryption fires under identical conditions and every check/error/
  order/side-effect is preserved. Notably, `relay-transport.awaitResponse` preserves the
  subtle "onClaimed-callback throw is swallowed, leaving `claimedNotified` set" edge case.

  The `dwn-api.ts` `constructDwnMessage` monster (CC 97) and the S107 parameter-count
  findings are deferred to dedicated follow-ups.

  Verified: build + lint clean across all five; connect (82), dids (320), dwn-clients
  (206), and agent (1357) test suites pass; dwn-sql-store's DB-backed suite runs in CI.

- [#1306](https://github.com/enboxorg/enbox/pull/1306) [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211) Thanks [@poindex-bot](https://github.com/poindex-bot)! - chore: resolve SonarCloud type/class-hygiene and test-quality findings

  Behavior-preserving cleanup (no functional changes):

  - **readonly** on public static / constructor-only members (S1444, S2933)
  - **named type aliases** for repeated inline unions (S4323)
  - **more specific test assertions** — `toBeInstanceOf` / `toBeNull` / `toHaveLength` (S5906)
  - merged identical conditional branches (S1871), `String.raw` (S7780), `.dataset` /
    `.remove()` DOM APIs (S7761/S7762), class-field init (S7757), `self`→lexical-`this`
    arrow closures (S7740), removed redundant `| undefined` (S4782), removed an
    unnecessary regex escape (S6535), documented intentional no-op methods (S1186),
    nested-template extraction (S4624), and a `role="button"` span → real `<button>`
    in the admin UI (S6819).

  Redundant-type-alias findings (S6564) on exported public API types, duplicated-code
  findings (S4144) needing design judgment, deprecated-API swaps without a drop-in
  replacement (S1874), and a few tests needing author intent were deliberately left
  for follow-up rather than risk breaking API or behavior.

- [#1335](https://github.com/enboxorg/enbox/pull/1335) [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: resolve SonarCloud maintainability findings — remove redundant type aliases (`KeyIdentifier`, `AlgorithmIdentifier`, `MulticodecCode`, `LinkId`, `DataStoreListParams`, `JsonRpcParams`, `ConnectRequest`/`ConnectResponse`, `AudienceDeliveryMessage`), extract a nested ternary in the browser connect modal, and convert early-return test skips to `test.skipIf()`

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

- [#1329](https://github.com/enboxorg/enbox/pull/1329) [`4c32046`](https://github.com/enboxorg/enbox/commit/4c320469d38f4f67c51ad6b82edca397fc0bd4c2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Refactor repeated feed convergence policy into a backend-neutral component.

- [#1304](https://github.com/enboxorg/enbox/pull/1304) [`4498e5a`](https://github.com/enboxorg/enbox/commit/4498e5ad249bb38e24047d1665b6a19849f5c8a9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Centralize each active replication link's subscriptions, pull ordering, push batching, repair, and reconciliation runtime in a backend-neutral lifetime controller.

- [#1326](https://github.com/enboxorg/enbox/pull/1326) [`132cd4a`](https://github.com/enboxorg/enbox/commit/132cd4ad25c428991e60ea52f2871457169e9072) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Refactor one-shot sync drain coordination into a backend-neutral component.

- [#1296](https://github.com/enboxorg/enbox/pull/1296) [`48fde39`](https://github.com/enboxorg/enbox/commit/48fde39d5857f8b7bb70ddbfc857ad276e49d27c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Refactor supplemental sync endpoint persistence behind a backend-neutral store contract while preserving the existing Level data format and target behavior.

- [#1301](https://github.com/enboxorg/enbox/pull/1301) [`74dd445`](https://github.com/enboxorg/enbox/commit/74dd445b283e476eb3c26d6fbd3f193c32fa924e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Persist replication-link status and directional checkpoints through a backend-neutral store so concurrent pull, push, repair, and status work cannot replace unrelated durable link state.

- [#1356](https://github.com/enboxorg/enbox/pull/1356) [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: structured machine-readable error fields on DWN message replies — reply `status` now carries optional `errorCode` (the `DwnErrorCode` of the originating `DwnError`) and `info` (structured error data, e.g. the squash backstop floor timestamp) so consumers no longer parse `detail` prose

- [#1354](https://github.com/enboxorg/enbox/pull/1354) [`76be6bb`](https://github.com/enboxorg/enbox/commit/76be6bba0e0f7a3ae25ee1829915974581960982) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: opt-in decryption of subscription event payloads

  `RecordsSubscribe` requests now accept `encryption: true` (auto-enabled by the typed layer on `encryptionRequired` paths): the agent decrypts the subscribe reply's initial snapshot entries and each event's inline payload before delivery, so subscription consumers read plaintext from `record.data` without re-reading every record through the read path. Events without inline data (large records) keep the lazy decrypting read; a record that cannot be decrypted never kills the subscription — its inline ciphertext is withheld and `record.data` rejects with the decryption error via the lazy read.

- [#1361](https://github.com/enboxorg/enbox/pull/1361) [`9e4be6d`](https://github.com/enboxorg/enbox/commit/9e4be6de0206e0c3e2cbd5e235405cffef75e1bc) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix(agent): resolve remaining sync audit findings with cross-context lifecycle locking

  - A link persisted with status `'repairing'` (a repair was in flight when the previous session ended) reloads as `'initializing'`, so the next session re-establishes live replication instead of refusing subscriptions forever; `'paused'` remains a durable decision.
  - The deferred-pull/dead-letter lifecycle is serialized per `(tenant)` across every context sharing the storage — browser tabs and workers via the Web Locks API, engine instances in one process via a keyed fallback queue. Admission cleanup, 24h expiry promotion, and unregister's tenant sweep each run their read-decide-write section under the lock, so a live admission can no longer race the expiry path into resurrected retry state or a false `admit-failed` dead letter that would permanently block the CID from re-admission.
  - Identity lifecycle mutations (register, update, unregister) take a cross-context per-DID lock — outermost, with the deferred-pull lock nesting inside — so one context's unregister can no longer interleave with another's re-registration and prune its freshly created durable links.
  - Unregister deletes tenant-scoped state first and the identity marker last as the commit point: a failed cleanup leaves the registration intact for a simple retry, and a re-registration can never inherit an aged `firstDeferredAt` that would instantly dead-letter its first deferral (new `SyncDeferredPullStore.deleteTenant`, exact-tenant key range).
  - An interrupted drain — caller cancellation or a topology change — no longer records a connectivity failure: interruptions say nothing about reachability and must not mark the engine offline or widen the poll backoff.

- [#1352](https://github.com/enboxorg/enbox/pull/1352) [`b964d48`](https://github.com/enboxorg/enbox/commit/b964d48ab993934337c348f6655e9923bfa409f3) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor(agent): make controller identity the staleness axis for link work

  Repair, reconcile scheduling, and push-failure routing now flow `SyncLinkController` references instead of `(linkKey, link)` pairs: the recovery coordinator's `transitionToRepairing`/`scheduleLinkReconcile`/`scheduleReconcile`, its `handlePushFailures` operation, the push coordinator's `handleReconcileFailures`, and the live-pull processor's repair/reconcile operations are controller-addressed, deleting the scattered `controller.link === link` object-identity re-checks in favor of `controller.isActive`. Link-addressed entry points that legitimately run without a controller keep their addressing: `transitionToPaused` still persists the paused status for poll-mode links, and the engine's `scheduleLinkReconcile` boundary resolves feed-convergence/quota-manager requests to a matching active controller exactly as the deleted internal guards did. No behavior change; fourth step of the runtime-scope (Phase-2) refactor.

- [#1283](https://github.com/enboxorg/enbox/pull/1283) [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix sync success cleanup so resolving a message for one tenant does not clear another tenant's dead letter for the same CID and remote endpoint

- [#1336](https://github.com/enboxorg/enbox/pull/1336) [`c7d1b82`](https://github.com/enboxorg/enbox/commit/c7d1b8265a73134cd55a6330b29d1ede137302c4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(agent): per-delivery sync events, scoped one-shot sync, coalesced concurrency, and per-link replication status; feat(auth): explicit sync mode option

  Sync engine (`@enbox/agent`):

  - New `delivery:applied` sync event, emitted once per **freshly** applied message a live-pull delivery admits — the delivered root AND any fetched dependency (parent, role record, initial write) the closure admitted alongside it — each with a routing descriptor (`interface`, `method`, `protocol`, `protocolPath`, `recordId`, `contextId`, `author`, `messageTimestamp`) so apps can invalidate exactly the affected state without re-querying. Echoes of messages the store already held (`Duplicate`/`Superseded` applies) do not emit — `admitClosure` now reports `freshEntries` (message + CID) alongside `appliedCids`.
  - `sync(direction?, options?)` accepts `options.did` to scope a one-shot run to a single registered identity's replication targets (an app-triggered "pull my inbox now" no longer re-reconciles every identity). An unregistered DID rejects.
  - Concurrent `sync()` calls now coalesce into one queued follow-up run instead of throwing `Sync operation is already in progress` — joined requests merge (differing directions widen to both, differing scopes widen to unscoped) and share the follow-up's outcome. A runtime transition (`stopSync`/`clear`/`close`/mode switch) while the follow-up is still queued cancels it, rejecting joiners with the new exported `SyncRunCancelledError` — a resolved `sync()` always means a run covering the request completed.
  - New `getReplicationLinks(tenantDid?)` returns read-only per-link snapshots (scope, status, connectivity, checkpoint positions, last activity). All links `'live'` is the per-identity caught-up signal for hot-added identities; `startSync()` resolving covers identities registered before start (now documented).
  - End-to-end regression coverage for the peer-authored inbox pattern: an `anyone`-create record written by a foreign author into the tenant's remote DWN is delivered through live sync in real time, wakes local `MessagesSubscribe` subscribers, and emits `delivery:applied` — including for identities hot-added after `startSync()`.

  Auth (`@enbox/auth`):

  - `SyncOption` now accepts `'live'` and `{ mode: 'live' | 'poll', interval? }` in addition to `'off'`. The bare interval string form (which silently selects poll mode and gives up real-time delivery) is deprecated and logs a one-time warning; behaviour is otherwise unchanged.

- [#1360](https://github.com/enboxorg/enbox/pull/1360) [`d564725`](https://github.com/enboxorg/enbox/commit/d564725121d6488eea74790cb5279b505ff09dc9) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor(agent): retire the engine generation counter and move sync mode onto the runtime scope

  `_engineGeneration` is deleted. The last consumers — the live subscription handler guards (`createLinkStalePredicate` and the push handler's staleness closure) — capture the runtime scope at subscription-open time and fence on `scope.disposed || !controller.isActive`, exactly equivalent since the counter was only ever incremented by transitions that also dispose the captured scope. `_syncMode` moves onto the scope as `SyncRuntime.mode`, set at construction for the generation and reading `undefined` once disposed — reproducing the old reset-on-transition without a separate field. Completes the Phase-2 runtime-scope refactor: lifecycle staleness is now expressed solely through scope disposal, transition fences, and controller identity.

- [#1283](https://github.com/enboxorg/enbox/pull/1283) [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - serialize sync identity mutations and drain per-identity live work before replacing or removing link runtime state

- [#1283](https://github.com/enboxorg/enbox/pull/1283) [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - make sync lifecycle transitions stop their timers and wait for active sync work before clearing or closing storage, while tolerating expected dead-letter cleanup races during teardown

- [#1340](https://github.com/enboxorg/enbox/pull/1340) [`d275b31`](https://github.com/enboxorg/enbox/commit/d275b31fb738a8f2aa2744dd14a4090481d2c9f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix(agent): harden sync lifecycle ahead of the runtime-scope refactor

  - `clear()`/`close()` now hold the exclusive sync lock through their destructive phase, so a concurrent `sync()`, `drainTo()`, or `retryRemoteNow()` can no longer interleave with the wipe (resurrecting replication links or the drain endpoint) or crash against a mid-close database. Callers that queued against the lock while the phase ran cancel through the engine's stale-work convention — they raced the destruction rather than followed it — instead of running on wiped state or surfacing a closed-storage error.
  - The DID-resolution link-init retry loop checks the runtime generation on both sides of each backoff sleep, so a retry can no longer re-activate a link controller and reopen live subscriptions after `stopSync()`/`close()` tore the runtime down.
  - `SyncReplicationLinkStoreLevel.persistCheckpoint` merges checkpoints monotonically within a token domain instead of overwriting, so a persist from a stale in-memory link instance can never regress `contiguousAppliedToken` — and a stale cross-domain `receivedToken` can no longer produce a mixed-domain checkpoint. A stream/epoch change still replaces the checkpoint (deliberate feed reset), and explicit `resetCheckpoint` still overwrites.

- [#1346](https://github.com/enboxorg/enbox/pull/1346) [`418030a`](https://github.com/enboxorg/enbox/commit/418030a14cd84a889a57aefe0237e5a2f2c39395) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix(agent): scope-own link-init retry timers and cancel them on identity mutations

  Pending rate-limit (Retry-After) link-initialization retries move from an engine-held timer map into the `SyncRuntime` scope as keyed one-shot timers, gaining the scope's guarantees: a runtime transition disposes them, and a firing the event loop queued before a replacement or disposal never starts. `SyncRuntime` adds `armTimeout`, `hasTimers`, and `clearTimers` for keyed one-shot arming and predicate-based queries.

  Behavioral fix: `updateIdentityOptions` and `unregisterIdentity` now cancel an identity's pending init retries unconditionally. Previously the cancellation only ran when live links were being rebuilt — but in exactly the rate-limited case the link controller was already dropped before the retry was armed, so the timer survived the mutation and could re-create a superseded durable link and reopen live subscriptions with the replaced scope and authorization epoch (or for an unregistered identity). An options update drains any retry that already started and immediately initializes replacement live targets, preserving live replication under the new scope and authorization epoch.

- [#1349](https://github.com/enboxorg/enbox/pull/1349) [`5b4e0d3`](https://github.com/enboxorg/enbox/commit/5b4e0d305ab9c142111ba8ec553a4d4bd18a8ff7) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor(agent): retire getGeneration from the sync collaborators in favor of runtime-scope handles

  The connectivity manager and link-recovery coordinator now capture a read-only `SyncRuntimeHandle` when they start work and fence their continuations on `scope.disposed` — a runtime transition disposes exactly the scope those captures reference, so the staleness semantics are unchanged while the engine-generation plumbing disappears from their operation contracts. The quota manager's probe staleness becomes purely the caller's `shouldContinue` fence: the engine composes a transition fence into every probe it threads down, valid from any state (an active scope trips when disposed; an already-disposed scope trips when a new runtime replaces it), so one-shot callers such as a stopped-state `retryRemoteNow` keep probing exactly as before. No behavior change; third step of the runtime-scope (Phase-2) refactor.

- [#1342](https://github.com/enboxorg/enbox/pull/1342) [`dd311d4`](https://github.com/enboxorg/enbox/commit/dd311d4459a8da2b1c6e0b233c10a5fa299e6548) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor(agent): introduce a SyncRuntime timer scope for the sync engine

  Adds an internal `SyncRuntime` ownership scope created per `startSync` generation. The engine's sync-interval timer (poll cadence and live settle check) is now armed through the scope under a stable key, and every runtime transition disposes the scope — cancelling all owned timers and refusing further arming — instead of hand-clearing a `_syncIntervalId` field. Each armed callback carries an ownership token that is re-checked when the event loop delivers a firing, so a callback whose timer was replaced or whose scope was disposed never starts — including firings the event loop had already queued, which `clearInterval` alone cannot retract. Async callback bodies that already started remain governed by lifecycle supervision and their own `disposed` re-checks after awaits. No behavior change; first step of the runtime-scope (Phase-2) refactor.

- [#1283](https://github.com/enboxorg/enbox/pull/1283) [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - track live sync callback, repair, reconcile, and push-flush work so lifecycle teardown drains in-flight tasks before clearing or closing storage

- [#1358](https://github.com/enboxorg/enbox/pull/1358) [`024cd55`](https://github.com/enboxorg/enbox/commit/024cd5592e5cecfbdea348747deb34da9ba21b94) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor(agent): move one-shot sync paths onto the runtime transition fence

  The queued `sync()` follow-up, the `retryRemoteNow` chain, the DID-resolution link-init retry loop, and link initialization drop their engine-generation captures. Runtime-scoped work (link init and its retry loop — reachable only under a live runtime) fences on the captured scope's `disposed` flag; any-state work (queued sync runs, `retryRemoteNow`) captures the transition fence, which trips on runtime start/stop/clear/close from any starting state. Every transition — including the `clear()`/`close()` destructive phase, which previously bumped the generation — now installs a fresh disposed scope object, so fences captured under an already-disposed scope also observe it. Behavior-preserving; first half of the Phase-2 finale (the remaining generation sites are the subscription-handler guards, migrating with the `_syncMode` relocation).

- [#1292](https://github.com/enboxorg/enbox/pull/1292) [`b5f49ac`](https://github.com/enboxorg/enbox/commit/b5f49ace4e6ab9e1caf23afb2cdd8735d44985b3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(sync): honor Retry-After on WebSocket subscription rate limits

  A tenant rate limit (429/`TooManyRequests`) on a `MessagesSubscribe`
  WebSocket subscription was surfaced as a generic error: the WS transport
  discarded the error code and `retryAfterSec`, and the sync engine marked
  the link permanently `Failed` with no rate-limit-aware retry — leaving
  live sync uninitialized for that target. HTTP requests already honored
  `Retry-After`; WebSocket subscriptions now match.

  - `web-socket-clients` translates a `TooManyRequests` subscribe error into
    a `RateLimitError` (preserving `retryAfterSec`), mirroring the HTTP
    client; other subscribe errors now surface as `DwnRpcError` with the
    original code/data instead of a bare `Error`.
  - `SyncEngineLevel` reschedules live-subscription initialization after the
    server-provided Retry-After window instead of failing the link. Durable
    feed reconciliation continues via the periodic settle check while the
    live subscription is deferred, so no data is lost.

- Updated dependencies [[`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441), [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c), [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67), [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0), [`b5f49ac`](https://github.com/enboxorg/enbox/commit/b5f49ace4e6ab9e1caf23afb2cdd8735d44985b3)]:
  - @enbox/dwn-sdk-js@0.4.13
  - @enbox/dwn-clients@0.4.20
  - @enbox/crypto@0.1.7
  - @enbox/dids@0.1.7
  - @enbox/connect@0.1.9
  - @enbox/common@0.1.4

## 0.8.27

### Patch Changes

- [#1280](https://github.com/enboxorg/enbox/pull/1280) [`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(replication): move negotiated HTTP RPC envelopes into a streaming request body and stop replaying dependencies the remote has already acknowledged

  HTTP clients now negotiate `body-v1` through the server's `/info` response. Supporting peers send the JSON-RPC envelope and optional raw record data in one length-prefixed, streaming body, avoiding proxy header limits without buffering or base64-expanding large attachments. Older servers continue to receive the legacy `dwn-request` header format.

  The agent now treats `Applied`, `Duplicate`, and `Superseded` dependency results as acknowledgements. If a root continues to report only acknowledged dependencies as missing, it is handed to delayed reconciliation instead of consuming the admission pass budget and immediate retry ladder.

- Updated dependencies [[`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131)]:
  - @enbox/dwn-clients@0.4.19

## 0.8.26

### Patch Changes

- Updated dependencies [[`f18cece`](https://github.com/enboxorg/enbox/commit/f18ceceeae21b85aa9898decffe479f6fb729bff)]:
  - @enbox/connect@0.1.8

## 0.8.25

### Patch Changes

- Updated dependencies [[`0a5cc42`](https://github.com/enboxorg/enbox/commit/0a5cc42c1d8920e6ba9326d6331b3b119c9e7892)]:
  - @enbox/connect@0.1.7

## 0.8.24

### Patch Changes

- [#1274](https://github.com/enboxorg/enbox/pull/1274) [`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83) Thanks [@poindex-bot](https://github.com/poindex-bot)! - Add delegated connect-session status, expiry error helpers, opt-in monitoring, and same-delegate grant refresh across the auth and browser APIs. Refresh requests now carry an explicit wallet UI signal, reuse the existing delegate keys on popup and relay transports, and select fresh active grants over expired or superseded grants. Connect results now fail closed when grants come from the wrong owner, exceed the requested scope, or contain no usable requested grant.

- Updated dependencies [[`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83)]:
  - @enbox/connect@0.1.6

## 0.8.23

### Patch Changes

- Updated dependencies [[`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081)]:
  - @enbox/crypto@0.1.6
  - @enbox/connect@0.1.5
  - @enbox/dids@0.1.6
  - @enbox/dwn-clients@0.4.18
  - @enbox/dwn-sdk-js@0.4.12

## 0.8.22

### Patch Changes

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11
  - @enbox/connect@0.1.4
  - @enbox/dwn-clients@0.4.17

## 0.8.21

### Patch Changes

- Updated dependencies [[`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919)]:
  - @enbox/connect@0.1.3

## 0.8.20

### Patch Changes

- [#1259](https://github.com/enboxorg/enbox/pull/1259) [`672a13f`](https://github.com/enboxorg/enbox/commit/672a13fd33dde00afdf8fd4fe2de649f06a1b93f) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix(agent): propagate out-of-batch `uses` dependencies during connect protocol preparation and surface per-endpoint failure reasons

  A composed protocol's `ProtocolsConfigure` is rejected by the DWN when a `uses` target is not installed for the tenant, and the connect batch only orders dependencies the requester also asked for — so approving a request for a composed protocol (e.g. profile, which `uses` social-graph) against an endpoint missing the dependency failed deterministically, and the real 400 rejection was silently discarded, leaving only the generic "Could not verify the latest protocol definition on every reachable DWN endpoint" error.

  `prepareProtocol` now propagates missing `uses` dependencies from the provider's locally stored configure entries (depth-first, transitive) to endpoints that are missing the dependent before sending its configure, checks the reply status of every configure send (previously fulfilled non-2xx replies were never read), and attaches the per-endpoint root cause — rejected sends, non-2xx replies with their detail, or the observed non-converged state — to the postcondition error.

## 0.8.19

### Patch Changes

- Updated dependencies [[`7e5f7ec`](https://github.com/enboxorg/enbox/commit/7e5f7ec504c8c4f552348c6a091fad389a408a45)]:
  - @enbox/connect@0.1.2

## 0.8.18

### Patch Changes

- [#1249](https://github.com/enboxorg/enbox/pull/1249) [`95ff115`](https://github.com/enboxorg/enbox/commit/95ff11501400dbd0786f14e769d50b833a8a871d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(connect): install composed protocols in `uses`-dependency order

  The connect approval ceremony prepared every requested protocol in one flat
  concurrent fan-out. The DWN's `ProtocolsConfigure` handler rejects a configure
  whose `uses` targets are not yet installed for the tenant, so a composing
  protocol (e.g. one that `uses` a social-graph protocol for a role) could race
  its dependency and land first — getting rejected and failing the fail-closed
  remote convergence check. On a fresh identity, where nothing is pre-installed,
  this reliably aborted the whole connect with "Could not verify the latest
  protocol definition on every reachable DWN endpoint".

  `prepareProtocol` is now fanned out in `uses`-dependency order: each protocol's
  in-batch dependencies fully converge across all endpoints before its dependents
  are prepared. Independent protocols within a dependency level are still prepared
  concurrently, and dependency cycles fall back to the previous best-effort
  concurrent behavior.

## 0.8.17

### Patch Changes

- [#1245](https://github.com/enboxorg/enbox/pull/1245) [`a61819a`](https://github.com/enboxorg/enbox/commit/a61819abe3e53751782e50df9a1b26e52e65463f) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(agent): connect approval ceremony performs encryption upgrades and fail-closed remote protocol verification

  `executeConnectApproval`'s per-protocol preparation (new `connect-protocol-preparation.ts`) now owns what wallets previously had to do before calling the ceremony: it rejects requester-supplied `$keyAgreement`/`$encryption` metadata and non-normalized protocol URIs, verifies installed definitions against the request (and installed `$keyAgreement` public keys against the provider's key deriver by JWK thumbprint), re-configures policy-identical installs that are missing encryption keys (encryption upgrade), verifies every reachable owner DWN endpoint before configuring (a reachable endpoint rejecting the query, a remote definition/key conflict, or zero reachable endpoints abort the approval), and fans the configure out with a fail-closed convergence postcondition. Wallets no longer need their own pre-approval `prepareProtocol` step.

  Behavior changes: an approval against a provider whose resolved endpoints are all unreachable now fails during protocol preparation instead of at grant delivery, and an installed-but-unencrypted protocol is now actually upgraded (previously the ceremony skipped any locally installed protocol, so encrypted writes against it kept failing after connect).

## 0.8.16

### Patch Changes

- [#1236](https://github.com/enboxorg/enbox/pull/1236) [`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(crypto): promote JOSE JWE engine with ECDH-ES (X25519), XC20P, and PIN-KDF support

- [#1237](https://github.com/enboxorg/enbox/pull/1237) [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.

- [#1233](https://github.com/enboxorg/enbox/pull/1233) [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: accept `EncryptionControl` dependency refs in replication apply results (previously rejected as malformed, breaking sync recovery of encryption-control dependencies) and remove dead legacy encryption paths: the unproducible `EncryptionProtocol` dependency-ref chain, raw-private-key decrypt/derive overloads superseded by KMS callbacks, the legacy role-epoch schema branch, unused `Delivery`/`GrantKey` precompiled validators, the test-only participant-detection cluster, and orphaned crypto primitives (`EciesSecp256k1`, `ConcatKdf`, plain `XChaCha20`, `AesCtrAlgorithm`, JOSE type duplicates).

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/connect@0.1.1
  - @enbox/dwn-sdk-js@0.4.10
  - @enbox/dwn-clients@0.4.16
  - @enbox/dids@0.1.5

## 0.8.15

### Patch Changes

- [#1232](https://github.com/enboxorg/enbox/pull/1232) [`378f3d4`](https://github.com/enboxorg/enbox/commit/378f3d4b07a011e9f56852cfc0a4e9da8cd13bd4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: serialize permission grant delivery per DWN endpoint so same-tenant writes do not time out while queued

- [#1214](https://github.com/enboxorg/enbox/pull/1214) [`d7f0a87`](https://github.com/enboxorg/enbox/commit/d7f0a87b211c7eb3fb2ee1e048a51b2deab2305a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add local-node runtime core and discovery-file token metadata

- [#1225](https://github.com/enboxorg/enbox/pull/1225) [`49449ad`](https://github.com/enboxorg/enbox/commit/49449ade45463baa3ac2190c5455b7dba1f1e39b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a sync drain API that reconciles registered identities to an explicit DWN endpoint and reports convergence progress.

- [#1228](https://github.com/enboxorg/enbox/pull/1228) [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Harden local-node ejection with authenticated stable drains, safe outage fallback, persisted consent, native token discovery, and durable local storage.

- [#1205](https://github.com/enboxorg/enbox/pull/1205) [`c12b323`](https://github.com/enboxorg/enbox/commit/c12b3239ce03bf29bcd2b3a37c8c650c7b29ace1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: harden local DWN remote-mode foundations

- [#1226](https://github.com/enboxorg/enbox/pull/1226) [`55581c7`](https://github.com/enboxorg/enbox/commit/55581c71dc1ea7bc8715f92c56ba71692f7bc33e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: deliver role-audience keys to DWN-less recipients via a supplied role-path key

  `ProcessDwnRequest` now accepts an optional `recipientRolePublicKey`. When writing a `$role` record with a `recipient`, the agent wraps the `$encryption/delivery` record to that key instead of resolving the recipient's role-path key from the recipient's DWN-hosted protocol definition. A recipient's role-path key is a hardened derivation of its own encryption root — only the recipient can produce it, and a DWN-less participant (e.g. a bare `did:jwk` running in "remote-only" mode) has no DWN to publish it to. The recipient computes it locally and hands it to the owner out of band (e.g. in a signed join request); the delivery record is written to the owner's DWN, so the participant stays DWN-less.

  Delivery is **best-effort**, whether or not a key is supplied. The `$role` write is authorized and accepted on its own; a delivery that cannot be provisioned — a DWN-less recipient with no supplied key, or a supplied key that fails to wrap — is reported on the new `DwnResponse.audienceKeyDelivery` (`{ delivered, recipientDid, reason }`) rather than throwing or unwinding the accepted write. This replaces a previously silent, default-off log: skipped deliveries are now visible and inspectable. A supplied `recipientRolePublicKey` only changes **which** key the delivery is wrapped to (the caller's, skipping recipient DID resolution) — not whether a failure is fatal.

  Because delivery never throws or rolls the record back, a supplied key works identically for an **owner-authored** write and a **grant-authorized** (`permissionGrantId` / `delegatedGrant`) write. The latter is the primary path for a delegated actor — e.g. a dashboard session delegate that authors every write on the owner's behalf via a `delegatedGrant` and never holds the owner key. A caller that treats delivery as required inspects the reported outcome and compensates with the authority it holds (e.g. deleting the just-written `$role` record with its own delete grant) rather than relying on the SDK to roll back — which a write-scoped grant could not authorize anyway.

  Additional validation, all enforced **before** the record is written:

  - **Supplied-key validation.** `recipientRolePublicKey` must be a well-formed AND usable X25519 OKP public key (`kty: 'OKP'`, `crv: 'X25519'`, no private `d`, and an `x` that is the canonical unpadded base64url of exactly 32 bytes). A non-X25519 key (e.g. Ed25519) previously wrapped through the X25519 ECDH without error but produced an undecryptable delivery reported as `delivered: true`; it is now rejected (not converted — the role-path key is a derived X25519 key, not the DID root). A non-canonical `x` (whose key id would not match what the recipient derives) and a low-order point (whose ephemeral ECDH fails key agreement) are also rejected.
  - **Misuse rejection.** Supplying `recipientRolePublicKey` where no delivery can ever be provisioned is a caller error rejected up front: `sendRequest`, a raw message, a non-`RecordsWrite`, `store: false`, or a target path that is not a `$role` with a `$keyAgreement` audience and a `recipient`.
  - **`AudienceKeyDeliveryOutcome` is a discriminated union** (`{ delivered: true }` | `{ delivered: false; reason }`) so invalid states no longer type-check. Consumers reading `outcome.reason` must first narrow on `outcome.delivered === false`.

- [#1215](https://github.com/enboxorg/enbox/pull/1215) [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve SonarCloud maintainability issues (S3863/S6594)

  Behavior-preserving source cleanups:

  - S3863: merge duplicate `import` statements from the same module into a
    single statement (re-sorting to satisfy the repo's `sort-imports` rule).
  - S6594: use `RegExp.exec()` instead of `String#match()` for the non-global
    route/type regexes in the DWN server and `universalTypeOf`.

- [#1212](https://github.com/enboxorg/enbox/pull/1212) [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve remaining SonarCloud reliability issues (S7773/S7781/S7758/S6853/S8786)

  Behavior-preserving reliability hardening across packages:

  - Replace global `parseInt`/`isNaN` with `Number.parseInt`/`Number.isNaN` (S7773).
  - Replace `String#replace(/…/g)` and `split().join()` with `String#replaceAll` (S7781).
  - Prefer `String.fromCodePoint`/`String#codePointAt` in byte-range encoders (S7758).
  - Associate admin-UI form labels with their inputs via `for`/`id` (S6853).
  - Strip trailing slashes in the local-node `/info` handler with a linear loop
    instead of a backtracking-prone regex (S8786).

- [#1216](https://github.com/enboxorg/enbox/pull/1216) [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve SonarCloud redundant-union-type issues (S6571)

  Type-only, behavior-preserving cleanups:

  - JOSE header/key types (`JweHeaderParams` `alg`/`enc`, `JwsHeaderParams` `alg`,
    `JwkUse`) and DID `@context` fields used `'literal' | … | string`, which
    TypeScript collapses to plain `string` — silently discarding the literal
    hints. Switched the trailing `| string` to `| (string & {})` so the
    registered/spec values provide editor autocomplete while any string is still
    accepted (required by the JOSE/DID specs). Matches the existing
    `(string & {})` pattern in `dwn-sdk-js` protocol types.
  - `ProtocolRuleSetValue` dropped the redundant `ProtocolDeliveryStrategy`
    constituent, whose `'direct' | 'subscribe'` values are already covered by the
    union's `string` member.

- Updated dependencies [[`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a), [`98f4348`](https://github.com/enboxorg/enbox/commit/98f4348bfbfb7d5ddbc91787f4187958998ba011), [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9), [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/dwn-clients@0.4.15
  - @enbox/common@0.1.3
  - @enbox/dids@0.1.4
  - @enbox/dwn-sdk-js@0.4.9
  - @enbox/crypto@0.1.4

## 0.8.14

### Patch Changes

- [#1202](https://github.com/enboxorg/enbox/pull/1202) [`d7467fe`](https://github.com/enboxorg/enbox/commit/d7467fef30d809e25bd0c840338301b9b9d912e0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: carry the wallet connect request pointer and encryption key in the URI fragment

  `EnboxConnectProtocol` now exposes `buildWalletConnectUri` and `parseWalletConnectUri`, which place the relay `request_uri` and the single-use `encryption_key` in the URI **fragment** rather than the query string. The fragment never leaves the local channel (it is not sent to the wallet's web server on the deep-link path), so the single-use symmetric key protecting the pushed request cannot surface in server or CDN logs. `WalletConnect.initClient` builds the wallet URI through the new helper; consumers that read connect parameters from a wallet URI should parse them with `parseWalletConnectUri`.

## 0.8.13

### Patch Changes

- [#1189](https://github.com/enboxorg/enbox/pull/1189) [`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Support wrapped grantKey delivery for pre-supplied delegate DIDs with encrypted read scopes.

- Updated dependencies [[`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/dwn-sdk-js@0.4.8
  - @enbox/dwn-clients@0.4.14

## 0.8.12

### Patch Changes

- [#1185](https://github.com/enboxorg/enbox/pull/1185) [`60a9abb`](https://github.com/enboxorg/enbox/commit/60a9abb62e3c16368793f17b9ee0e735938ae804) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: stop sync before revoking session grants and park links on revoked/expired authorization

  Disconnect revoked delegated grants while live sync still ran under them, so the engine treated the self-inflicted 401s as repairable failures — error stacks and pointless retries on every successful delegate disconnect. AuthManager.disconnect() now stops sync first (revocation delivery is direct RPC and unaffected), and SyncEngineLevel classifies GrantAuthorizationGrantRevoked/GrantAuthorizationGrantExpired/MessagesSubscribeDeliveryAuthorizationFailed as terminal: the link parks (paused) with one concise log line instead of repair-retrying, which also quiets wallet-initiated revocation while a tool is running.

## 0.8.11

### Patch Changes

- [#1180](https://github.com/enboxorg/enbox/pull/1180) [`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: release sockets and store handles on shutdown so CLI processes exit

  WebSocket RPC connections are pooled process-wide with heartbeat timers and were never closed, keeping the event loop alive after AuthManager.shutdown() resolved; the agent's DWN stores, DID resolver cache, and vault/secret stores also stayed open, wedging same-dataPath reopens and cross-process writes. Adds WebSocketDwnRpcClient.closeAllConnections() and a close() contract to EnboxRpc, a full EnboxUserAgent.shutdown() lifecycle, and delegates AuthManager.shutdown() to it.

- Updated dependencies [[`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979)]:
  - @enbox/dwn-clients@0.4.13

## 0.8.10

### Patch Changes

- [#1159](https://github.com/enboxorg/enbox/pull/1159) [`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add a CLI relay connect handler package

- [#1173](https://github.com/enboxorg/enbox/pull/1173) [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add pre-supplied delegate DID support to relay connect flows so CLI clients can keep delegate private keys local while wallets grant to the requested DID.

- [#1171](https://github.com/enboxorg/enbox/pull/1171) [`9211810`](https://github.com/enboxorg/enbox/commit/921181002eacc4fdec2264c1334cc7e91b3b0781) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: honor requested connect session TTLs when stamping wallet grants

## 0.8.9

### Patch Changes

- [#1152](https://github.com/enboxorg/enbox/pull/1152) [`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish browser-conditioned entrypoints without Node global shim requirements

- [#1121](https://github.com/enboxorg/enbox/pull/1121) [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: dedupe runtime dependency versions and pin dependency declarations

- [#1120](https://github.com/enboxorg/enbox/pull/1120) [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency footprint by moving optional backends behind subpath imports and optional peer dependencies, removing unused DID and helper packages, and replacing small CLI/runtime dependencies with built-in implementations.

- [#1106](https://github.com/enboxorg/enbox/pull/1106) [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: expand durable grantKey coverage for role-path encryption keys

- [#1146](https://github.com/enboxorg/enbox/pull/1146) [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: isolate Level-backed DWN and DID store implementations behind explicit subpath exports

- [#1098](https://github.com/enboxorg/enbox/pull/1098) [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: make DWN key wrapping algorithm-discriminated

- [#1156](https://github.com/enboxorg/enbox/pull/1156) [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove the legacy epoch-based role-audience encryption path and pin sealed-audience end-to-end coverage.

- [#1137](https://github.com/enboxorg/enbox/pull/1137) [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: replace direct ms usage with a shared duration parser.

- [#1138](https://github.com/enboxorg/enbox/pull/1138) [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: admit source-protocol role-audience encryption entries

- [#1154](https://github.com/enboxorg/enbox/pull/1154) [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove role-creator audience delivery paths and require seal-covered audience minting.

- [#1151](https://github.com/enboxorg/enbox/pull/1151) [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: replace delegate response key delivery with sealed audience control records

- [#1155](https://github.com/enboxorg/enbox/pull/1155) [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: share sealed audience key wrapping and agent read-through helpers

- [#1144](https://github.com/enboxorg/enbox/pull/1144) [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: move the Level-backed common store behind a dedicated optional subpath.

- Updated dependencies [[`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251), [`7ddb0d6`](https://github.com/enboxorg/enbox/commit/7ddb0d677065483968ef9d80773e3fd81048f4ad), [`37895ff`](https://github.com/enboxorg/enbox/commit/37895ff511258ed48d10660b1f73ce597e818921), [`cda1d31`](https://github.com/enboxorg/enbox/commit/cda1d31b4c8a7df444beadd0271ff50a3482fa00), [`5de6973`](https://github.com/enboxorg/enbox/commit/5de6973f98216a3732800a6ec461520b47171902), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`042879e`](https://github.com/enboxorg/enbox/commit/042879ea1e05d45b99ab35e23f1ab2f730afa757), [`efa5171`](https://github.com/enboxorg/enbox/commit/efa5171b36aa0f46e957e74506323f9cbd4d8dc7), [`97dced6`](https://github.com/enboxorg/enbox/commit/97dced6b0eb80fccbd71ea5a8a1c250ba40153bb), [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e), [`78cd3e5`](https://github.com/enboxorg/enbox/commit/78cd3e5b8412b308077f318b58bf5fd3db63d996), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`23ae738`](https://github.com/enboxorg/enbox/commit/23ae7389a4c14aedf360c5b3b3bbdd8c274ef53a), [`b38dd5e`](https://github.com/enboxorg/enbox/commit/b38dd5ec24129a37e8e2bb17b3173144ac9bb863), [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`96bc5f5`](https://github.com/enboxorg/enbox/commit/96bc5f5c2d80f0cb543042e3f41f5c2d4156c3d3), [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6), [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c), [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688), [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852), [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46), [`57c66a3`](https://github.com/enboxorg/enbox/commit/57c66a34079625793c8b26028f29d1eb63b969ef)]:
  - @enbox/dids@0.1.3
  - @enbox/dwn-sdk-js@0.4.7
  - @enbox/common@0.1.2
  - @enbox/crypto@0.1.3
  - @enbox/dwn-clients@0.4.12

## 0.8.8

### Patch Changes

- [#1095](https://github.com/enboxorg/enbox/pull/1095) [`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor encryption key material and key wrapping abstractions

- [#1097](https://github.com/enboxorg/enbox/pull/1097) [`d8726ea`](https://github.com/enboxorg/enbox/commit/d8726eae2002fc45e479d850b1fefd1af70bbb80) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(agent): add `AgentDwnApi.provisionRoleAudienceEpoch` to eagerly provision a role-audience epoch for a `(protocol, contextId, role)` without adding a member. Mints + persists the audience keypair and writes the public `audienceEpoch` record (idempotent; reused by later member-adds), so records for a role can carry a `roleAudience` entry before any member of that role exists.

- Updated dependencies [[`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1)]:
  - @enbox/dwn-sdk-js@0.4.6
  - @enbox/dwn-clients@0.4.11

## 0.8.7

### Patch Changes

- [#1090](https://github.com/enboxorg/enbox/pull/1090) [`2333413`](https://github.com/enboxorg/enbox/commit/23334132ac1b6441e249e4482535df6a049f87d4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: verify delivered audience keys against accepted epochs and role assignments

- [#1083](https://github.com/enboxorg/enbox/pull/1083) [`b96eb50`](https://github.com/enboxorg/enbox/commit/b96eb508d7a9ebd6ec7a7a15fec62e7e26d12a18) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add durable grantKey production and cache-miss decryption resolution for delegated encrypted reads.

- [#1080](https://github.com/enboxorg/enbox/pull/1080) [`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: complete DWN encryption storage lookup and remove legacy encryption surface

- [#1077](https://github.com/enboxorg/enbox/pull/1077) [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: implement DWN encryption v1 records, protocol keys, and delegate key delivery

- [#1084](https://github.com/enboxorg/enbox/pull/1084) [`bae4e73`](https://github.com/enboxorg/enbox/commit/bae4e730197e389f1458aac70f3a8e664432b7c9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: verify durable grant keys reference active permission grants

- [#1087](https://github.com/enboxorg/enbox/pull/1087) [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add initial role-audience encryption key delivery and decryption support. Epoch rotation for membership changes remains tracked separately.

- Updated dependencies [[`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7), [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37), [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc)]:
  - @enbox/dwn-sdk-js@0.4.5
  - @enbox/crypto@0.1.2
  - @enbox/dwn-clients@0.4.10
  - @enbox/dids@0.1.2

## 0.8.6

### Patch Changes

- [#1074](https://github.com/enboxorg/enbox/pull/1074) [`41233ae`](https://github.com/enboxorg/enbox/commit/41233ae542882a1245734d0bdf9435dfab919793) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix delegated sync permission grant bootstrap so wallet-connected agents do not need owner signing keys during push reconciliation.

## 0.8.5

### Patch Changes

- [#1072](https://github.com/enboxorg/enbox/pull/1072) [`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add bounded, display-only connect session metadata to permission grants and default connect-created grants to a hard 24-hour expiration.

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/dwn-sdk-js@0.4.4
  - @enbox/dwn-clients@0.4.9

## 0.8.4

### Patch Changes

- [#1070](https://github.com/enboxorg/enbox/pull/1070) [`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use `Records.Read` as the canonical read-like records permission for read, query, subscribe, and count operations. Connect requests now emit only read/write/delete record permissions, reject obsolete record query/subscribe/count grant scopes, and keep protocol configuration wallet-owned instead of delegating `Protocols.Configure` to apps. Delegate `TypedEnbox` auto-configuration imports the wallet's signed protocol configuration locally instead of requiring a delegated configure grant.

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/dwn-sdk-js@0.4.3
  - @enbox/dwn-clients@0.4.8

## 0.8.3

### Patch Changes

- [#1068](https://github.com/enboxorg/enbox/pull/1068) [`7ee6ff9`](https://github.com/enboxorg/enbox/commit/7ee6ff98bd01a673aab23f46d69db1b90f8ccd91) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Surface one-shot sync failures when remote DWN reconciliation fails.

## 0.8.2

### Patch Changes

- [#1058](https://github.com/enboxorg/enbox/pull/1058) [`4d96b19`](https://github.com/enboxorg/enbox/commit/4d96b19e36be398dde948e783b9240d93ec57aa2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Consolidate the sync push/pull dependency-closure fetch helpers (grant resolution, dependency-ref utilities, protocol-config helpers) that were duplicated verbatim in `sync-messages.ts` and `sync-admit-closure.ts` into a shared `sync-fetch-helpers.ts` module. The shared grant resolver also narrows its error handling so unexpected grant-lookup failures (store/network/parse errors) surface instead of being silently swallowed as "no grant".

- Updated dependencies [[`05f5621`](https://github.com/enboxorg/enbox/commit/05f56216adcbdba09ae039238055a4591674ef88)]:
  - @enbox/dwn-sdk-js@0.4.2
  - @enbox/dwn-clients@0.4.7

## 0.8.1

### Patch Changes

- [#1038](https://github.com/enboxorg/enbox/pull/1038) [`12413b1`](https://github.com/enboxorg/enbox/commit/12413b121b5387a1eb03faee4651b3770e1b2f6e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: preserve caller-owned DWN store and event-log wiring in AgentDwnApi.createDwn

- [#1020](https://github.com/enboxorg/enbox/pull/1020) [`db83e50`](https://github.com/enboxorg/enbox/commit/db83e508fbc8e1628ef736c46a590aad6dec432a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add internal MessagesQuery feed helpers for the agent sync engine.

- [#1023](https://github.com/enboxorg/enbox/pull/1023) [`777bd26`](https://github.com/enboxorg/enbox/commit/777bd26c428c6f1562fed743831f085b683541d5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Enforce RecordsWrite descriptor dataSize limits while syncing record data streams.

- [#1026](https://github.com/enboxorg/enbox/pull/1026) [`69c6367`](https://github.com/enboxorg/enbox/commit/69c6367a2c597ba858eed0eb28de099ab491199e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: pull remote sync entries from the durable message feed

- [#1027](https://github.com/enboxorg/enbox/pull/1027) [`15817c9`](https://github.com/enboxorg/enbox/commit/15817c96e407175f4c8fb4a56a784bc56aa9959a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: push sync entries from the durable message feed

- [#1049](https://github.com/enboxorg/enbox/pull/1049) [`09f7002`](https://github.com/enboxorg/enbox/commit/09f700217297b8101f4689f5e8a84c8a910f2def) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: collapse terminal sync link status into paused state

- [#1018](https://github.com/enboxorg/enbox/pull/1018) [`0e4f67c`](https://github.com/enboxorg/enbox/commit/0e4f67c0c76c5d56603a5d5115ee7253d90fa0c9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add MessagesQuery to the agent DWN request surface and treat Messages.Read grants as covering message feed queries.

- [#1014](https://github.com/enboxorg/enbox/pull/1014) [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add durable message-store progress positions and replication feed primitives, preserve same-CID index/data-completion transitions, fail fast on pre-substrate Level/IndexedDB layouts, and remove obsolete DWN record upgrade code.

- [#1028](https://github.com/enboxorg/enbox/pull/1028) [`228d8dc`](https://github.com/enboxorg/enbox/commit/228d8dcd2d211f7953b86e7e7c4358d9fdb27827) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Switch the active sync cycle to durable feed pull/push reconciliation, remove the orphaned legacy reconciler path, and keep dead-letter divergence visible as degraded health instead of treating it as convergence evidence.

- [#1024](https://github.com/enboxorg/enbox/pull/1024) [`79a860d`](https://github.com/enboxorg/enbox/commit/79a860d2a007c4eb9092d46221bda61fbb0e8348) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: resume live sync subscriptions from durable applied cursors

- [#1043](https://github.com/enboxorg/enbox/pull/1043) [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Require nested protocol Query, Count, and Subscribe filters to pin the direct parent contextId, make permission revocation filtering opt-in with scalar per-grant checks, and route delegated sync scope derivation through the permissions API.

- [#1022](https://github.com/enboxorg/enbox/pull/1022) [`4ed695f`](https://github.com/enboxorg/enbox/commit/4ed695f18e4f9b2a4a2a68ca47fb39e4933e35b2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Emit sync checkpoint events for high-water cursors that do not carry a message CID.

- [#1021](https://github.com/enboxorg/enbox/pull/1021) [`8928c5d`](https://github.com/enboxorg/enbox/commit/8928c5dfb6b5d8e44db016222bdb9acb8941f099) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use remote DID-document DWN endpoints for sync targets and rotate sync projection IDs for the durable message-feed engine.

- [#1035](https://github.com/enboxorg/enbox/pull/1035) [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove legacy sync index, wire, and sparse-tree surfaces now that replication uses durable message feeds and scoped fingerprints.

- [#1005](https://github.com/enboxorg/enbox/pull/1005) [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove Bun fetch stream buffering workarounds and pass data streams through HTTP and storage paths directly.

- [#1036](https://github.com/enboxorg/enbox/pull/1036) [`49e2a4b`](https://github.com/enboxorg/enbox/commit/49e2a4be2db6692219519674e2b2f2b2db5c9c23) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: remove legacy sync engine state and stale ordering wrappers

- [#1037](https://github.com/enboxorg/enbox/pull/1037) [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: remove the legacy event-log emit surface and use store-owned wakes for embedded DWNs

- [#1030](https://github.com/enboxorg/enbox/pull/1030) [`97fffdf`](https://github.com/enboxorg/enbox/commit/97fffdfa827995c75497fe22a2a7631fb7c0a22d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: validate sync protocol scope closure during registration

- [#1025](https://github.com/enboxorg/enbox/pull/1025) [`4129d17`](https://github.com/enboxorg/enbox/commit/4129d1712503ad67010630f729ef37d4ea8fc27b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: normalize DWN endpoints for sync links and WebSocket connections

- Updated dependencies [[`970aa97`](https://github.com/enboxorg/enbox/commit/970aa972013c61d9acc6a077f2f5ec2ae72ebf54), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`211049b`](https://github.com/enboxorg/enbox/commit/211049bd7727c80b701e8d6be243a5c464b8bc81), [`5c1e8dc`](https://github.com/enboxorg/enbox/commit/5c1e8dc6bdfee56dce59d9aa963e74c7b4e7ce77), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`e781263`](https://github.com/enboxorg/enbox/commit/e78126309fc09e20be025ac2bf793632234a58f3), [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7), [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801), [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`a2bfa0d`](https://github.com/enboxorg/enbox/commit/a2bfa0dafff6a60d3b0343fcade2c6e4d7d871cf), [`f90c4b8`](https://github.com/enboxorg/enbox/commit/f90c4b8a77007337b9ec7711c14885759efab383), [`4129d17`](https://github.com/enboxorg/enbox/commit/4129d1712503ad67010630f729ef37d4ea8fc27b)]:
  - @enbox/dwn-sdk-js@0.4.1
  - @enbox/dwn-clients@0.4.6

## 0.8.0

### Minor Changes

- [#996](https://github.com/enboxorg/enbox/pull/996) [`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove the speculative records-projection MessagesSync path and dependency hints. Sync now uses only full and protocol-root StateIndex roots.

  Removed the `recordsProjection` `SyncScope` variant, records-projection scope helpers, `RecordsProjection`, and the MessagesSync dependency-hint wire types/exports.

### Patch Changes

- [#998](https://github.com/enboxorg/enbox/pull/998) [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Retry sync pushes when a child record reaches a remote before its parent, while keeping malformed protocol-path failures permanent.

- [#1002](https://github.com/enboxorg/enbox/pull/1002) [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Route sync push through remote replicated admission and use `ReplicationApplyResult` as the source of truth for push success, dependency fetching, retry, and terminal dead-letter classification.

  Remote DWNs must run a server version exposing `dwn.applyReplicatedMessage` before publishing this agent package.

- [#1001](https://github.com/enboxorg/enbox/pull/1001) [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Route sync pulls through structured replicated-message admission and remove the old closure-repair compensation layer.

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/dwn-sdk-js@0.4.0
  - @enbox/dwn-clients@0.4.5

## 0.7.10

### Patch Changes

- Updated dependencies [[`5908941`](https://github.com/enboxorg/enbox/commit/590894124552537f9088638b7a3527d4f7f3fda9)]:
  - @enbox/dwn-sdk-js@0.3.9
  - @enbox/dwn-clients@0.4.4

## 0.7.9

### Patch Changes

- [#984](https://github.com/enboxorg/enbox/pull/984) [`4837d72`](https://github.com/enboxorg/enbox/commit/4837d725a96739c2c5fae892018087b238577e8a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Repair scoped live sync closure when protocol metadata arrives after records by fetching and applying tenant-signed protocol configs from the remote DWN.

## 0.7.8

### Patch Changes

- [#975](https://github.com/enboxorg/enbox/pull/975) [`6aaab40`](https://github.com/enboxorg/enbox/commit/6aaab40bffd77b09d05275f2d786b8091c336188) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Resolve delegated path and context `Messages.Read` grants into Records-primary projected `MessagesSync` targets.

- [#968](https://github.com/enboxorg/enbox/pull/968) [`edd4b0f`](https://github.com/enboxorg/enbox/commit/edd4b0f27685de001bcff3cb9ca75410708043b0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Order composed protocol configurations after their referenced protocol configurations during sync apply.

- [#959](https://github.com/enboxorg/enbox/pull/959) [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Close delegated MessagesSubscribe streams when invoked grants become invalid during delivery, surface terminal live-query errors, and keep subscription resume checkpoints monotonic.

- [#971](https://github.com/enboxorg/enbox/pull/971) [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Support exact protocolPath and contextId subtree scope matching for Messages.Read grants. Permission records are now authorized through the protocol scope embedded in each grant record instead of blanket access from a grant scoped directly to the Permissions protocol.

- [#981](https://github.com/enboxorg/enbox/pull/981) [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Include and verify payload-free initial-write dependency hints for projected sync delete tombstones.

- [#978](https://github.com/enboxorg/enbox/pull/978) [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add projected MessagesSync protocol-config closure hints and apply verified config dependencies before projected primary records.

- [#956](https://github.com/enboxorg/enbox/pull/956) [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a shared permission scope matcher and use it for scoped grant checks. Scoped grant authorization now uses exact protocolPath matching, boundary-aware contextId subtree matching, and distinct Messages grant authorization error codes.

- [#964](https://github.com/enboxorg/enbox/pull/964) [`5bcc5ac`](https://github.com/enboxorg/enbox/commit/5bcc5ac00a2c478c09737e725d6df50d4d017c2f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Validate locally present closure dependencies against the current sync scope and dependency policy.

- [#965](https://github.com/enboxorg/enbox/pull/965) [`92011b6`](https://github.com/enboxorg/enbox/commit/92011b6938b0e59eabf3b7ee3849f6e5f339c7a3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Scope sync health degraded-link counts to current durable sync targets.

- [#961](https://github.com/enboxorg/enbox/pull/961) [`e7946e7`](https://github.com/enboxorg/enbox/commit/e7946e7e7e517be5c1c1b9c643f6e01305252ef9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Abort in-flight reconciliation pulls when their sync link is no longer current.

- [#954](https://github.com/enboxorg/enbox/pull/954) [`37cac82`](https://github.com/enboxorg/enbox/commit/37cac82c0f3476f1e76eeae22665b1656a4c687e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Preserve closure dead letters when sync roots converge and expose closure failure state in sync health.

- [#966](https://github.com/enboxorg/enbox/pull/966) [`31111b6`](https://github.com/enboxorg/enbox/commit/31111b651716e2a56f68fba93a43891e38c82161) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Prune superseded durable sync links when identity sync scope or authorization epoch changes.

- [#960](https://github.com/enboxorg/enbox/pull/960) [`6222ba9`](https://github.com/enboxorg/enbox/commit/6222ba9c90552e891cd4797196835544bd437a38) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Reject pulled sync messages that fall outside a protocol-scoped link before applying them locally.

- [#958](https://github.com/enboxorg/enbox/pull/958) [`485bc75`](https://github.com/enboxorg/enbox/commit/485bc757375824265de3c294a00db9ab826620c8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use canonical sync projection IDs and authorization epochs for full/protocol sync links. Protocol-list sync now uses one protocol-set link per tenant, endpoint, projection, and authorization epoch while delegated sync invokes the active Messages.Read grant set.

- Updated dependencies [[`22dffaa`](https://github.com/enboxorg/enbox/commit/22dffaa13cceb18935a20508fb131f5bb83993dd), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`1a9ba9d`](https://github.com/enboxorg/enbox/commit/1a9ba9db3aa09e7dd73e22e6f555c63eba978fb1), [`923b14f`](https://github.com/enboxorg/enbox/commit/923b14ffc986a7c98ee11a73d979d5d869579881), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`650f630`](https://github.com/enboxorg/enbox/commit/650f6306d42b6aaece08a811c437a59f4eb896b3), [`c801dc7`](https://github.com/enboxorg/enbox/commit/c801dc7045a109f210a1a6d7306f3e215bca9db7), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`67947ca`](https://github.com/enboxorg/enbox/commit/67947ca12d3e5e1343f3ade8dd8c6e261ad41ac3), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3)]:
  - @enbox/dwn-sdk-js@0.3.8
  - @enbox/dwn-clients@0.4.3

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
