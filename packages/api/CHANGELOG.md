# @enbox/api

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
