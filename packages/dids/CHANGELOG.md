# @enbox/dids

## 0.1.8

### Patch Changes

- Updated dependencies [[`ca04167`](https://github.com/enboxorg/enbox/commit/ca04167e6e6e61eea56eedd5eb7acbc3b909fd4c)]:
  - @enbox/common@0.1.5
  - @enbox/crypto@0.1.8

## 0.1.7

### Patch Changes

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

- Updated dependencies [[`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e)]:
  - @enbox/crypto@0.1.7
  - @enbox/common@0.1.4

## 0.1.6

### Patch Changes

- Updated dependencies [[`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081)]:
  - @enbox/crypto@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5

## 0.1.4

### Patch Changes

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

- Updated dependencies [[`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/common@0.1.3
  - @enbox/crypto@0.1.4

## 0.1.3

### Patch Changes

- [#1152](https://github.com/enboxorg/enbox/pull/1152) [`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish browser-conditioned entrypoints without Node global shim requirements

- [#1120](https://github.com/enboxorg/enbox/pull/1120) [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency footprint by moving optional backends behind subpath imports and optional peer dependencies, removing unused DID and helper packages, and replacing small CLI/runtime dependencies with built-in implementations.

- [#1139](https://github.com/enboxorg/enbox/pull/1139) [`78cd3e5`](https://github.com/enboxorg/enbox/commit/78cd3e5b8412b308077f318b58bf5fd3db63d996) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: inline BEP44 signing byte encoding.

- [#1146](https://github.com/enboxorg/enbox/pull/1146) [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: isolate Level-backed DWN and DID store implementations behind explicit subpath exports

- [#1137](https://github.com/enboxorg/enbox/pull/1137) [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: replace direct ms usage with a shared duration parser.

- Updated dependencies [[`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46)]:
  - @enbox/common@0.1.2
  - @enbox/crypto@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37)]:
  - @enbox/crypto@0.1.2

## 0.1.1

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

- [#926](https://github.com/enboxorg/enbox/pull/926) [`3dcfbcb`](https://github.com/enboxorg/enbox/commit/3dcfbcbf836d4cf85d5c7c23801ee13d1b7ba978) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(security): block SSRF via redirects in did:web/did:dht, reject path traversal in concatenateUrl, fix biased randomPin distribution

  - `@enbox/common`: new `isPrivateHostname` / `assertPublicUrl` / `fetchPublicUrl` / `PublicUrlValidationError` helpers; `concatenateUrl` now rejects `..`, `%2F`/`%5C`, malformed percent-encoding, and raw `?`/`#` in the path.
  - `@enbox/dids`: new `allowPrivateGatewayUri` option (default `false`) and `DidErrorCode.InvalidGatewayUri`; redirects from Pkarr / did:web are re-validated on every hop.
  - `@enbox/crypto`: `randomPin` now uses proper unbiased rejection sampling and enough random bytes for the full digit range.

- Updated dependencies [[`400c70a`](https://github.com/enboxorg/enbox/commit/400c70ac2e7ed82a0adad86f3688e682f488bd62), [`03899ca`](https://github.com/enboxorg/enbox/commit/03899ca7d20ad48b874f7e6253381f19cd7c3480), [`3dcfbcb`](https://github.com/enboxorg/enbox/commit/3dcfbcbf836d4cf85d5c7c23801ee13d1b7ba978)]:
  - @enbox/common@0.1.1
  - @enbox/crypto@0.1.1

## 0.1.0

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

## 0.0.9

### Patch Changes

- Updated dependencies [[`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/common@0.0.7
  - @enbox/crypto@0.0.8

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
  - @enbox/common@0.0.5
  - @enbox/crypto@0.0.6

## 0.0.6

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/common@0.0.4
  - @enbox/crypto@0.0.5

## 0.0.5

### Patch Changes

- [#242](https://github.com/enboxorg/enbox/pull/242) [`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.

## 0.0.4

### Patch Changes

- Updated dependencies [[`af2ba3a`](https://github.com/enboxorg/enbox/commit/af2ba3a7e9d5de44b40a38169e9296427a4f049b)]:
  - @enbox/crypto@0.0.4

## 0.0.3

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/common@0.0.3
  - @enbox/crypto@0.0.3

This package is a fork of the official Web5 DIDs package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/web5-js](https://github.com/decentralized-identity/web5-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
