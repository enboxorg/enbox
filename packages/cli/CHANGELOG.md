# @enbox/cli

## 0.1.35

### Patch Changes

- Updated dependencies [[`b9b6e84`](https://github.com/enboxorg/enbox/commit/b9b6e84c9614adc81d63896491b2bc927e34547d)]:
  - @enbox/agent@0.8.43
  - @enbox/api@0.6.82
  - @enbox/auth@0.6.89

## 0.1.34

### Patch Changes

- Updated dependencies [[`8f4715d`](https://github.com/enboxorg/enbox/commit/8f4715d461862ea11ab560b75338ebdcd87b79bf)]:
  - @enbox/agent@0.8.42
  - @enbox/api@0.6.81
  - @enbox/auth@0.6.88

## 0.1.33

### Patch Changes

- [#1637](https://github.com/enboxorg/enbox/pull/1637) [`1af0250`](https://github.com/enboxorg/enbox/commit/1af0250c6632002121d43cc3a8d37ce20db1bc84) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add request-time app identity hints, compatible session metadata, one-hour grant defaults, provider-selected lifetimes, and recoverable profile-locked reconnect routes

- Updated dependencies [[`1af0250`](https://github.com/enboxorg/enbox/commit/1af0250c6632002121d43cc3a8d37ce20db1bc84)]:
  - @enbox/connect@0.1.21
  - @enbox/agent@0.8.41
  - @enbox/auth@0.6.87
  - @enbox/api@0.6.80

## 0.1.32

### Patch Changes

- [#1632](https://github.com/enboxorg/enbox/pull/1632) [`eebdf97`](https://github.com/enboxorg/enbox/commit/eebdf9754773c1c8fb4836c8f3e106c2a1f60a62) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove the duplicate `Enbox` connect, refresh, and disconnect lifecycle. `ConnectionStore` now owns session lifecycle orchestration and closes the session-bound `Enbox` data facade automatically. Stores either own the `AuthManager` they create or borrow an explicitly supplied manager; caller-owned agents must be wrapped in a caller-owned manager.

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

- Updated dependencies [[`54cb801`](https://github.com/enboxorg/enbox/commit/54cb80166846b3395cd3543ae8a1c387ae5857d3), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0), [`eebdf97`](https://github.com/enboxorg/enbox/commit/eebdf9754773c1c8fb4836c8f3e106c2a1f60a62), [`137ce5f`](https://github.com/enboxorg/enbox/commit/137ce5f652af3f469329039cdd1cca4b675c7a36), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0), [`1eabea1`](https://github.com/enboxorg/enbox/commit/1eabea135a67906fb9730c58244f40077e312bec), [`7435259`](https://github.com/enboxorg/enbox/commit/743525922b963264c909f25c6a98d688807b5fb0)]:
  - @enbox/api@0.6.79
  - @enbox/agent@0.8.40
  - @enbox/auth@0.6.86
  - @enbox/connect@0.1.20

## 0.1.31

### Patch Changes

- [#1616](https://github.com/enboxorg/enbox/pull/1616) [`175222e`](https://github.com/enboxorg/enbox/commit/175222e679ab2c1c7cf293eaea8a59dab906e4f2) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: canonicalize absent JWK algorithms in the DID-DHT DNS codec and restrict CLI connect URLs to http(s)

- Updated dependencies [[`6cfbbd5`](https://github.com/enboxorg/enbox/commit/6cfbbd5fef64846aeb54fff8c07f94266cf4c5ec), [`b5c2d3e`](https://github.com/enboxorg/enbox/commit/b5c2d3eb59ac0f63d8deccca12706303318667e0), [`5ecf249`](https://github.com/enboxorg/enbox/commit/5ecf249c93a0a820e26bbcab9d10673acd6cb4eb), [`aa471e4`](https://github.com/enboxorg/enbox/commit/aa471e429731ae612f92e5df65a95c1c36036f79), [`7d9e946`](https://github.com/enboxorg/enbox/commit/7d9e9469d6d642329e38e7a8281b5ed0af01bc02), [`2cf5cfc`](https://github.com/enboxorg/enbox/commit/2cf5cfcaf8046fe4895233e45ff5760e083bf6bc), [`b5c2d3e`](https://github.com/enboxorg/enbox/commit/b5c2d3eb59ac0f63d8deccca12706303318667e0)]:
  - @enbox/api@0.6.78
  - @enbox/agent@0.8.39
  - @enbox/auth@0.6.85
  - @enbox/connect@0.1.19

## 0.1.30

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.38
  - @enbox/api@0.6.77
  - @enbox/auth@0.6.84
  - @enbox/connect@0.1.18

## 0.1.29

### Patch Changes

- Updated dependencies [[`aa2f44c`](https://github.com/enboxorg/enbox/commit/aa2f44c13245b76e3494974a63a94e6416b26ee5)]:
  - @enbox/agent@0.8.37
  - @enbox/api@0.6.76
  - @enbox/auth@0.6.83
  - @enbox/connect@0.1.17

## 0.1.28

### Patch Changes

- Updated dependencies [[`87129bd`](https://github.com/enboxorg/enbox/commit/87129bd86cd1c3a0c0c7d288407f063e3ef5a030), [`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48), [`41ce181`](https://github.com/enboxorg/enbox/commit/41ce181a981b17cc82d50bc496b0a2cab97df820), [`cf909fd`](https://github.com/enboxorg/enbox/commit/cf909fd4f6394d81e87e0a24d6f46ea1bb76a1a1), [`cb112bc`](https://github.com/enboxorg/enbox/commit/cb112bcbc0b4e0f545ad5852a6c5fcd10fd0103b), [`20e1c7c`](https://github.com/enboxorg/enbox/commit/20e1c7c12cb829dd8c0da0a76bc0064df49598e6), [`69a1c6a`](https://github.com/enboxorg/enbox/commit/69a1c6ad9c68a36e19c3f93dcc379e7ac16f4f15), [`23b11e8`](https://github.com/enboxorg/enbox/commit/23b11e899f8f463ea897a6af17858ae639b34c48), [`a2848ac`](https://github.com/enboxorg/enbox/commit/a2848acf96fee15fba5701ddb3e04f4b98787f3e), [`16b7cbc`](https://github.com/enboxorg/enbox/commit/16b7cbc5e7d5f69dc0b87738c0cc6e69951ce649), [`fa8346c`](https://github.com/enboxorg/enbox/commit/fa8346cd21c2edb91270b0d198312d0855244584)]:
  - @enbox/agent@0.8.36
  - @enbox/api@0.6.75
  - @enbox/auth@0.6.82
  - @enbox/connect@0.1.16

## 0.1.27

### Patch Changes

- [#1492](https://github.com/enboxorg/enbox/pull/1492) [`fb7ca10`](https://github.com/enboxorg/enbox/commit/fb7ca10fdc7b58a2e97d59658063033805491a9a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add typed application manifests and structural protocol-request normalization. Applications can retain `TypedProtocol` codecs locally while projecting only raw definitions and explicit permission policies into delegated auth requests.

- [#1494](https://github.com/enboxorg/enbox/pull/1494) [`d818618`](https://github.com/enboxorg/enbox/commit/d8186183f76b5556c26dd94a3ece5fc3db411a44) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add application protocol readiness. Owner sessions install locally, publish to
  the identity's hosted DWN, and verify the active remote definition. Delegated
  sessions validate and import the wallet-owned configuration without publishing.
- Updated dependencies [[`00dafdf`](https://github.com/enboxorg/enbox/commit/00dafdf88c517df248639680dc89616e9f42616d), [`fb7ca10`](https://github.com/enboxorg/enbox/commit/fb7ca10fdc7b58a2e97d59658063033805491a9a), [`c625d63`](https://github.com/enboxorg/enbox/commit/c625d6398feff887d2051bba6e5d5e306eaa3fdf), [`d818618`](https://github.com/enboxorg/enbox/commit/d8186183f76b5556c26dd94a3ece5fc3db411a44), [`8d288dd`](https://github.com/enboxorg/enbox/commit/8d288dd80fab6e4bcf0f92f3cde37799a13fcf05), [`659372d`](https://github.com/enboxorg/enbox/commit/659372de22c2cf7481fa4d28ba2b6380483e93a4), [`80dab68`](https://github.com/enboxorg/enbox/commit/80dab686cb24691f6df5fdc46a61552cbeb5faf4), [`33dba16`](https://github.com/enboxorg/enbox/commit/33dba165f9f5770044ccafb9f1f0572f2f555abf)]:
  - @enbox/agent@0.8.35
  - @enbox/api@0.6.74
  - @enbox/auth@0.6.81
  - @enbox/connect@0.1.15

## 0.1.26

### Patch Changes

- [#1463](https://github.com/enboxorg/enbox/pull/1463) [`96c5dbd`](https://github.com/enboxorg/enbox/commit/96c5dbddfb921a4972dc552a4d64ea9c7086b6ad) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Replace phantom schema-map typing with runtime record codecs. Typed records now encode and decode through their protocol declaration, expose application values through `Record.value()`, and use `within` as the single hierarchy selector. Remove the superseded schema-map types, caller-controlled `Record.update()` data-format overrides, generic `RecordData.json<T>()`, and root utilities namespace. Typed protocol declarations reject `$ref` composition until referenced protocol metadata can be supplied explicitly.

  Replace the public `generateTypes()` and `CodegenOptions.emitDefinition` codegen surface with `generateProtocolModule()`, which emits complete codec-backed protocol modules from protocol definitions and declared MIME formats. Expose the codec primitives through the browser and CLI facades.

- Updated dependencies [[`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c), [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c), [`ddff1e1`](https://github.com/enboxorg/enbox/commit/ddff1e18e854053a901ba601cb4102ead4b6e36c), [`5e9f5ce`](https://github.com/enboxorg/enbox/commit/5e9f5cecffa18004af2c891f833eb743c9f14d7e), [`f8a7ff1`](https://github.com/enboxorg/enbox/commit/f8a7ff1f9a40af66e1bdeb313e1131d7cbe12a48), [`96c5dbd`](https://github.com/enboxorg/enbox/commit/96c5dbddfb921a4972dc552a4d64ea9c7086b6ad)]:
  - @enbox/agent@0.8.34
  - @enbox/api@0.6.73
  - @enbox/auth@0.6.80
  - @enbox/connect@0.1.14

## 0.1.25

### Patch Changes

- [#1429](https://github.com/enboxorg/enbox/pull/1429) [`f804103`](https://github.com/enboxorg/enbox/commit/f80410366f4e3798018618f2f15ed014fd3796e8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add one protocol-derived `RecordQuery` shared by typed record queries and counts, including exact path tag and data-format types. Add authenticated `DwnApi.records.count()`, preserve query/count population parity, and expose the canonical query and count-response types from browser builds. Published-date filters and sorting explicitly select published records for both operations.

  Remove the overlapping typed query aliases, `queryAll()` drains, Repository facade, and high-level subscription models. Typed records now have one query/count contract, explicit create/update operations, and no client-side upsert or parallel collection abstraction. Callers page explicitly through `query()` with its returned cursor.

  Flatten advanced RecordsSubscribe and MessagesSubscribe to their raw DWN contract: a required subscription handler and the unmodified protocol reply. Remove `LiveQuery`, `TypedLiveQuery`, `MessagesLiveQuery`, record hydration, and `includeRecords`; a later observed-view API will be the sole high-level reactive model. Use `filter.contextId` for typed child selection; protocol identity and the exact-parent fence are derived internally. These intentional breaking changes remove the superseded exports from API, browser, and CLI without compatibility aliases.

  Resolve delegated record-read grants from the wire filter as the single protocol source, reject empty typed context IDs, and surface permission-store failures instead of silently treating them as missing grants. Delegated permission lookup now reuses a bounded grant catalog across record contexts while matching each requested scope independently.

  Resolve delegated record writes and deletes against their protocol path and context instead of selecting protocol-wide grants only. Permission lookups now reuse cached catalogs by default and expose `forceRefresh` for an explicit store refresh, while a scope miss refreshes the store so newly imported grants are immediately visible.

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

- Updated dependencies [[`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774), [`f804103`](https://github.com/enboxorg/enbox/commit/f80410366f4e3798018618f2f15ed014fd3796e8), [`764a470`](https://github.com/enboxorg/enbox/commit/764a470290d7167f1e1d8bb0702947aceeec3c0c), [`23d84a4`](https://github.com/enboxorg/enbox/commit/23d84a4cd94d169423d9fbe5c84b5e7bd803b134), [`2c78d33`](https://github.com/enboxorg/enbox/commit/2c78d3371c3cb26fea33245866326b9e43df528e), [`e07585c`](https://github.com/enboxorg/enbox/commit/e07585ce0e7ffcb65a32c51e1da22d48588339e0), [`50c40fd`](https://github.com/enboxorg/enbox/commit/50c40fd50950d5a25c0d5c342f55b078adf247e9), [`7a6abfd`](https://github.com/enboxorg/enbox/commit/7a6abfd92ca2cb019f5a7aa5260d12d06c59ce8d), [`713c757`](https://github.com/enboxorg/enbox/commit/713c7577c2ece2f59929f5f226abdf6cf40a7e1c)]:
  - @enbox/agent@0.8.33
  - @enbox/api@0.6.72
  - @enbox/auth@0.6.79
  - @enbox/connect@0.1.13

## 0.1.24

### Patch Changes

- Updated dependencies [[`4043f46`](https://github.com/enboxorg/enbox/commit/4043f46136cf23f08eb092976f1cb12cbb600ca7), [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2), [`61ceb57`](https://github.com/enboxorg/enbox/commit/61ceb575144c0eea39cee6938ce2f2c474c8b6f2), [`64115f8`](https://github.com/enboxorg/enbox/commit/64115f8d9fbfb37bf16cb04603556a0873de6b53), [`4426e72`](https://github.com/enboxorg/enbox/commit/4426e72a213fffbf420ce776fb2adb31c9c4f9b3), [`82e2f62`](https://github.com/enboxorg/enbox/commit/82e2f628fd6441eb4ca81be0b13952d11fbe6cba), [`a0aa94e`](https://github.com/enboxorg/enbox/commit/a0aa94e727320063dbb806aab57979abbbfb82b1), [`c603c33`](https://github.com/enboxorg/enbox/commit/c603c333387644b2d250cc4e778be1ebb14581ff), [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2), [`87afa05`](https://github.com/enboxorg/enbox/commit/87afa055a2aa23e7981f83dbff1ff2add138ea94), [`4062e4a`](https://github.com/enboxorg/enbox/commit/4062e4ab7e588c11a7f2fcfe302ac5cf048e4624), [`686c918`](https://github.com/enboxorg/enbox/commit/686c918e33d11af23314a2be421d3b66028020a1), [`7a437b2`](https://github.com/enboxorg/enbox/commit/7a437b2bed8cdb88b30eec86fb6420801845a352), [`06793a4`](https://github.com/enboxorg/enbox/commit/06793a4ddb8577b6f73c59db001e89fa2499f18c)]:
  - @enbox/agent@0.8.32
  - @enbox/api@0.6.71
  - @enbox/auth@0.6.78
  - @enbox/connect@0.1.12

## 0.1.23

### Patch Changes

- Updated dependencies [[`f688ea7`](https://github.com/enboxorg/enbox/commit/f688ea711b3bb3547e47f8f1697e3af54c441b2c)]:
  - @enbox/api@0.6.70

## 0.1.22

### Patch Changes

- Updated dependencies [[`bad337e`](https://github.com/enboxorg/enbox/commit/bad337e27a7f5e1029780401a419bc5c313c03ff), [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3), [`6688e32`](https://github.com/enboxorg/enbox/commit/6688e327e27d52a55d6daabdcfe1195f2954a67a)]:
  - @enbox/agent@0.8.31
  - @enbox/api@0.6.69
  - @enbox/auth@0.6.77
  - @enbox/connect@0.1.11

## 0.1.21

### Patch Changes

- Updated dependencies [[`257fa11`](https://github.com/enboxorg/enbox/commit/257fa11e014b59a758e93dcdeb8dec9b6deb989b), [`da812fc`](https://github.com/enboxorg/enbox/commit/da812fcfd501f4135682683f2960793c0ad37d26), [`83020bd`](https://github.com/enboxorg/enbox/commit/83020bdcf86e4db86f00f877c88427fc7e36f7bc), [`8b9ab70`](https://github.com/enboxorg/enbox/commit/8b9ab7017d5ac9d37920249c54d75264cad1fe99), [`3804b5d`](https://github.com/enboxorg/enbox/commit/3804b5dc1ddb94cd7beaff7045345efd474f6965), [`b334497`](https://github.com/enboxorg/enbox/commit/b33449751d36dd5c3bfddce7d208c75a9418bf50), [`08c6912`](https://github.com/enboxorg/enbox/commit/08c69121ecdfcfe2adc7758e7242d28b894caa95)]:
  - @enbox/agent@0.8.30
  - @enbox/auth@0.6.76
  - @enbox/api@0.6.68

## 0.1.20

### Patch Changes

- Updated dependencies [[`9dd09a6`](https://github.com/enboxorg/enbox/commit/9dd09a6d76a98eb54da813b1a3dc9b648527f7f3), [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca)]:
  - @enbox/agent@0.8.29
  - @enbox/api@0.6.67
  - @enbox/auth@0.6.75
  - @enbox/connect@0.1.10

## 0.1.19

### Patch Changes

- Updated dependencies [[`c4ee0bc`](https://github.com/enboxorg/enbox/commit/c4ee0bc057fb5b2278926fe1d9d1add618acc08d), [`6ad8f08`](https://github.com/enboxorg/enbox/commit/6ad8f08b2b87a9915ddbc6b289284a2b6635fbbd), [`48149b9`](https://github.com/enboxorg/enbox/commit/48149b970383af60d1113019c7a54b3f26cdd24c), [`851ffb4`](https://github.com/enboxorg/enbox/commit/851ffb40396e710b596463c62b055034b3882fad), [`1774805`](https://github.com/enboxorg/enbox/commit/1774805f09934ff839c3008bfcbf2bf4fff04963), [`16c8ea4`](https://github.com/enboxorg/enbox/commit/16c8ea46380d303fb20eeec7047b5f1f286f661f), [`3e6d5fe`](https://github.com/enboxorg/enbox/commit/3e6d5fe51f3ae16db0c08174132bcdc828f15c93), [`e83cb4b`](https://github.com/enboxorg/enbox/commit/e83cb4b05e7f184e515ccd547f5ac1c346fea045), [`f41a755`](https://github.com/enboxorg/enbox/commit/f41a755adfe769ad1ca5b00b7275059f2ed2305e), [`73a76e1`](https://github.com/enboxorg/enbox/commit/73a76e1099ebfb6b8e399431541a43d14d3df5ec), [`8f6cc7d`](https://github.com/enboxorg/enbox/commit/8f6cc7de740771a15a7eb1732d0597b2082fb347), [`d5c8e83`](https://github.com/enboxorg/enbox/commit/d5c8e8300ffb30ba89580ea0a37c3f9513470572), [`3309d87`](https://github.com/enboxorg/enbox/commit/3309d87efdea35ca784917b3b0ec05362a4a7c81), [`7f4c4e7`](https://github.com/enboxorg/enbox/commit/7f4c4e7b485f47b8cf0d6c40d60054363f4c56e3), [`a40eb11`](https://github.com/enboxorg/enbox/commit/a40eb11831bd9e669ed1a6b5dca58274be82d9de), [`e33cf82`](https://github.com/enboxorg/enbox/commit/e33cf820fec511d09676f5ea5473fa6db8727c5f), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`8d59d0b`](https://github.com/enboxorg/enbox/commit/8d59d0b39e7d0cfefdb4a416da669aa77a69cda7), [`cd6940e`](https://github.com/enboxorg/enbox/commit/cd6940e28434cac31587bd2745ce3411d670bfa3), [`757cff1`](https://github.com/enboxorg/enbox/commit/757cff17cbb8bec36f806eec1a8ee3606f3c9ae2), [`2b50952`](https://github.com/enboxorg/enbox/commit/2b5095252fc621d6ea35db5a330759009c2a88e2), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`9889d7d`](https://github.com/enboxorg/enbox/commit/9889d7dcaf9fb53d2da7efea08b8d3c3f173932e), [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`d6f72b4`](https://github.com/enboxorg/enbox/commit/d6f72b4ec9f50fd86f288021416c7f22a61c60ed), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`4c32046`](https://github.com/enboxorg/enbox/commit/4c320469d38f4f67c51ad6b82edca397fc0bd4c2), [`4498e5a`](https://github.com/enboxorg/enbox/commit/4498e5ad249bb38e24047d1665b6a19849f5c8a9), [`132cd4a`](https://github.com/enboxorg/enbox/commit/132cd4ad25c428991e60ea52f2871457169e9072), [`48fde39`](https://github.com/enboxorg/enbox/commit/48fde39d5857f8b7bb70ddbfc857ad276e49d27c), [`74dd445`](https://github.com/enboxorg/enbox/commit/74dd445b283e476eb3c26d6fbd3f193c32fa924e), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0), [`76be6bb`](https://github.com/enboxorg/enbox/commit/76be6bba0e0f7a3ae25ee1829915974581960982), [`9e4be6d`](https://github.com/enboxorg/enbox/commit/9e4be6de0206e0c3e2cbd5e235405cffef75e1bc), [`b964d48`](https://github.com/enboxorg/enbox/commit/b964d48ab993934337c348f6655e9923bfa409f3), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`c7d1b82`](https://github.com/enboxorg/enbox/commit/c7d1b8265a73134cd55a6330b29d1ede137302c4), [`d564725`](https://github.com/enboxorg/enbox/commit/d564725121d6488eea74790cb5279b505ff09dc9), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`d275b31`](https://github.com/enboxorg/enbox/commit/d275b31fb738a8f2aa2744dd14a4090481d2c9f4), [`418030a`](https://github.com/enboxorg/enbox/commit/418030a14cd84a889a57aefe0237e5a2f2c39395), [`5b4e0d3`](https://github.com/enboxorg/enbox/commit/5b4e0d305ab9c142111ba8ec553a4d4bd18a8ff7), [`dd311d4`](https://github.com/enboxorg/enbox/commit/dd311d4459a8da2b1c6e0b233c10a5fa299e6548), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`024cd55`](https://github.com/enboxorg/enbox/commit/024cd5592e5cecfbdea348747deb34da9ba21b94), [`b5f49ac`](https://github.com/enboxorg/enbox/commit/b5f49ace4e6ab9e1caf23afb2cdd8735d44985b3)]:
  - @enbox/agent@0.8.28
  - @enbox/api@0.6.66
  - @enbox/auth@0.6.74
  - @enbox/connect@0.1.9

## 0.1.18

### Patch Changes

- Updated dependencies [[`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131)]:
  - @enbox/agent@0.8.27
  - @enbox/api@0.6.65
  - @enbox/auth@0.6.73

## 0.1.17

### Patch Changes

- Updated dependencies [[`f18cece`](https://github.com/enboxorg/enbox/commit/f18ceceeae21b85aa9898decffe479f6fb729bff)]:
  - @enbox/connect@0.1.8
  - @enbox/agent@0.8.26
  - @enbox/auth@0.6.72
  - @enbox/api@0.6.64

## 0.1.16

### Patch Changes

- Updated dependencies [[`0a5cc42`](https://github.com/enboxorg/enbox/commit/0a5cc42c1d8920e6ba9326d6331b3b119c9e7892)]:
  - @enbox/connect@0.1.7
  - @enbox/agent@0.8.25
  - @enbox/auth@0.6.71
  - @enbox/api@0.6.63

## 0.1.15

### Patch Changes

- [#1274](https://github.com/enboxorg/enbox/pull/1274) [`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83) Thanks [@poindex-bot](https://github.com/poindex-bot)! - Add delegated connect-session status, expiry error helpers, opt-in monitoring, and same-delegate grant refresh across the auth and browser APIs. Refresh requests now carry an explicit wallet UI signal, reuse the existing delegate keys on popup and relay transports, and select fresh active grants over expired or superseded grants. Connect results now fail closed when grants come from the wrong owner, exceed the requested scope, or contain no usable requested grant.

- Updated dependencies [[`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83)]:
  - @enbox/agent@0.8.24
  - @enbox/connect@0.1.6
  - @enbox/auth@0.6.70
  - @enbox/api@0.6.62

## 0.1.14

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.23
  - @enbox/api@0.6.61
  - @enbox/auth@0.6.69
  - @enbox/connect@0.1.5

## 0.1.13

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.8.22
  - @enbox/api@0.6.60
  - @enbox/auth@0.6.68
  - @enbox/connect@0.1.4

## 0.1.12

### Patch Changes

- Updated dependencies [[`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919)]:
  - @enbox/connect@0.1.3
  - @enbox/agent@0.8.21
  - @enbox/auth@0.6.67
  - @enbox/api@0.6.59

## 0.1.11

### Patch Changes

- Updated dependencies [[`672a13f`](https://github.com/enboxorg/enbox/commit/672a13fd33dde00afdf8fd4fe2de649f06a1b93f)]:
  - @enbox/agent@0.8.20
  - @enbox/api@0.6.58
  - @enbox/auth@0.6.66

## 0.1.10

### Patch Changes

- Updated dependencies [[`7e5f7ec`](https://github.com/enboxorg/enbox/commit/7e5f7ec504c8c4f552348c6a091fad389a408a45)]:
  - @enbox/connect@0.1.2
  - @enbox/agent@0.8.19
  - @enbox/auth@0.6.65
  - @enbox/api@0.6.57

## 0.1.9

### Patch Changes

- Updated dependencies [[`95ff115`](https://github.com/enboxorg/enbox/commit/95ff11501400dbd0786f14e769d50b833a8a871d)]:
  - @enbox/agent@0.8.18
  - @enbox/api@0.6.56
  - @enbox/auth@0.6.64

## 0.1.8

### Patch Changes

- Updated dependencies [[`a61819a`](https://github.com/enboxorg/enbox/commit/a61819abe3e53751782e50df9a1b26e52e65463f)]:
  - @enbox/agent@0.8.17
  - @enbox/api@0.6.55
  - @enbox/auth@0.6.63

## 0.1.7

### Patch Changes

- [#1237](https://github.com/enboxorg/enbox/pull/1237) [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/agent@0.8.16
  - @enbox/connect@0.1.1
  - @enbox/auth@0.6.62
  - @enbox/api@0.6.54

## 0.1.6

### Patch Changes

- Updated dependencies [[`378f3d4`](https://github.com/enboxorg/enbox/commit/378f3d4b07a011e9f56852cfc0a4e9da8cd13bd4), [`d7f0a87`](https://github.com/enboxorg/enbox/commit/d7f0a87b211c7eb3fb2ee1e048a51b2deab2305a), [`49449ad`](https://github.com/enboxorg/enbox/commit/49449ade45463baa3ac2190c5455b7dba1f1e39b), [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a), [`c12b323`](https://github.com/enboxorg/enbox/commit/c12b3239ce03bf29bcd2b3a37c8c650c7b29ace1), [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9), [`55581c7`](https://github.com/enboxorg/enbox/commit/55581c71dc1ea7bc8715f92c56ba71692f7bc33e), [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/agent@0.8.15
  - @enbox/auth@0.6.61
  - @enbox/api@0.6.53

## 0.1.5

### Patch Changes

- Updated dependencies [[`d7467fe`](https://github.com/enboxorg/enbox/commit/d7467fef30d809e25bd0c840338301b9b9d912e0)]:
  - @enbox/agent@0.8.14
  - @enbox/auth@0.6.60
  - @enbox/api@0.6.52

## 0.1.4

### Patch Changes

- Updated dependencies [[`96ea6cb`](https://github.com/enboxorg/enbox/commit/96ea6cbda08a4bb6540d8a4e2664278f82d6fba8), [`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/auth@0.6.59
  - @enbox/api@0.6.51
  - @enbox/agent@0.8.13

## 0.1.3

### Patch Changes

- [#1183](https://github.com/enboxorg/enbox/pull/1183) [`0dd7dff`](https://github.com/enboxorg/enbox/commit/0dd7dffff90360b0d0e6d82574b3b9a33a872ab0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: validate connect grants (grantee, scope subset) in the shared connect path for every transport

  The grantee-matches-delegate and granted-scopes-subset checks lived in the CLI handler only, so browser popup and direct relay connects imported whatever a wallet returned. The validation now runs in AuthManager's handler flow and in walletConnect, and @enbox/cli drops its private copy.

- Updated dependencies [[`60a9abb`](https://github.com/enboxorg/enbox/commit/60a9abb62e3c16368793f17b9ee0e735938ae804), [`0dd7dff`](https://github.com/enboxorg/enbox/commit/0dd7dffff90360b0d0e6d82574b3b9a33a872ab0)]:
  - @enbox/agent@0.8.12
  - @enbox/auth@0.6.58
  - @enbox/api@0.6.50

## 0.1.2

### Patch Changes

- Updated dependencies [[`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979)]:
  - @enbox/agent@0.8.11
  - @enbox/auth@0.6.57
  - @enbox/api@0.6.49

## 0.1.1

### Patch Changes

- [#1159](https://github.com/enboxorg/enbox/pull/1159) [`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add a CLI relay connect handler package

- [#1175](https://github.com/enboxorg/enbox/pull/1175) [`8a5f43e`](https://github.com/enboxorg/enbox/commit/8a5f43ea4f594bdedc6360c1aab473c177f22ea5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: resolve the connect relay from the wallet's well-known document and default CLI sessions to a 30-day requested TTL

- [#1173](https://github.com/enboxorg/enbox/pull/1173) [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add pre-supplied delegate DID support to relay connect flows so CLI clients can keep delegate private keys local while wallets grant to the requested DID.

- Updated dependencies [[`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331), [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff), [`9211810`](https://github.com/enboxorg/enbox/commit/921181002eacc4fdec2264c1334cc7e91b3b0781)]:
  - @enbox/agent@0.8.10
  - @enbox/auth@0.6.56
  - @enbox/api@0.6.48
