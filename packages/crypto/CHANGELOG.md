# @enbox/crypto

## 0.1.8

### Patch Changes

- Updated dependencies [[`ca04167`](https://github.com/enboxorg/enbox/commit/ca04167e6e6e61eea56eedd5eb7acbc3b909fd4c)]:
  - @enbox/common@0.1.5

## 0.1.7

### Patch Changes

- [#1307](https://github.com/enboxorg/enbox/pull/1307) [`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity in JWE/COSE functions (Sonar S3776)

  Behavior-preserving extract-method refactoring of 7 crypto functions flagged for
  excessive cognitive complexity, bringing each to the ≤15 threshold. Every change
  lifts a contiguous, self-contained block (a full algorithm branch, header-validation
  pass, or CBOR-decode step — following the existing RFC-comment boundaries) into a
  named private helper called at the exact same point. No validation, allow-list, or
  security check was reordered, weakened, merged, or removed, and no error type/code/
  message changed.

  - `FlattenedJwe.decrypt` / `encrypt` — header validation, algorithm-allow-list
    enforcement (still before key management), CEK resolution (incl. the RFC 7516
    §11.5 timing-attack CEK-substitution fallback), and ciphertext dispatch extracted.
  - `JweKeyManagement.decrypt` — per-`alg` branches (`dir` / `ECDH-ES` / `PBES2`, incl.
    the `minP2cCount` iteration-count guard) extracted; the switch dispatch is untouched.
  - `CoseKey.fromJwk` / `toJwk`, `CoseSign1.decode`, `Eat.parseClaims` — OKP/EC2 key
    mapping, COSE_Sign1 envelope decoding, and CWT/EAT claim extraction extracted.

  Verified: `@enbox/crypto` build + lint clean; all 748 crypto tests pass (including
  the JWE/COSE security vectors and round-trips).

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

- Updated dependencies [[`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e)]:
  - @enbox/common@0.1.4

## 0.1.6

### Patch Changes

- [#1272](https://github.com/enboxorg/enbox/pull/1272) [`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: fall back to @noble/ciphers' RFC 3394 AES-KW implementation when the runtime's WebCrypto lacks the AES-KW algorithm (Electron/BoringSSL-built Node), instead of failing with "Unrecognized algorithm name". RFC 3394 is deterministic, so fallback output is byte-identical to native WebCrypto in both directions; on every runtime where WebCrypto supports AES-KW, the native path is unchanged. (Changeset for #1270, which merged without one.)

## 0.1.5

### Patch Changes

- [#1236](https://github.com/enboxorg/enbox/pull/1236) [`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(crypto): promote JOSE JWE engine with ECDH-ES (X25519), XC20P, and PIN-KDF support

- [#1233](https://github.com/enboxorg/enbox/pull/1233) [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: accept `EncryptionControl` dependency refs in replication apply results (previously rejected as malformed, breaking sync recovery of encryption-control dependencies) and remove dead legacy encryption paths: the unproducible `EncryptionProtocol` dependency-ref chain, raw-private-key decrypt/derive overloads superseded by KMS callbacks, the legacy role-epoch schema branch, unused `Delivery`/`GrantKey` precompiled validators, the test-only participant-detection cluster, and orphaned crypto primitives (`EciesSecp256k1`, `ConcatKdf`, plain `XChaCha20`, `AesCtrAlgorithm`, JOSE type duplicates).

## 0.1.4

### Patch Changes

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

- Updated dependencies [[`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41)]:
  - @enbox/common@0.1.3

## 0.1.3

### Patch Changes

- [#1121](https://github.com/enboxorg/enbox/pull/1121) [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: dedupe runtime dependency versions and pin dependency declarations

- Updated dependencies [[`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46)]:
  - @enbox/common@0.1.2

## 0.1.2

### Patch Changes

- [#1077](https://github.com/enboxorg/enbox/pull/1077) [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: implement DWN encryption v1 records, protocol keys, and delegate key delivery

## 0.1.1

### Patch Changes

- [#926](https://github.com/enboxorg/enbox/pull/926) [`3dcfbcb`](https://github.com/enboxorg/enbox/commit/3dcfbcbf836d4cf85d5c7c23801ee13d1b7ba978) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(security): block SSRF via redirects in did:web/did:dht, reject path traversal in concatenateUrl, fix biased randomPin distribution

  - `@enbox/common`: new `isPrivateHostname` / `assertPublicUrl` / `fetchPublicUrl` / `PublicUrlValidationError` helpers; `concatenateUrl` now rejects `..`, `%2F`/`%5C`, malformed percent-encoding, and raw `?`/`#` in the path.
  - `@enbox/dids`: new `allowPrivateGatewayUri` option (default `false`) and `DidErrorCode.InvalidGatewayUri`; redirects from Pkarr / did:web are re-validated on every hop.
  - `@enbox/crypto`: `randomPin` now uses proper unbiased rejection sampling and enough random bytes for the full digit range.

- Updated dependencies [[`400c70a`](https://github.com/enboxorg/enbox/commit/400c70ac2e7ed82a0adad86f3688e682f488bd62), [`03899ca`](https://github.com/enboxorg/enbox/commit/03899ca7d20ad48b874f7e6253381f19cd7c3480), [`3dcfbcb`](https://github.com/enboxorg/enbox/commit/3dcfbcbf836d4cf85d5c7c23801ee13d1b7ba978)]:
  - @enbox/common@0.1.1

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

## 0.0.8

### Patch Changes

- [#643](https://github.com/enboxorg/enbox/pull/643) [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Update remaining Web5 references in JSDoc, comments, and package metadata to Enbox

  - Replace ~60 stale "Web5" references in JSDoc/comments across agent, api, auth, browser, crypto, and dwn-server packages
  - Update package.json descriptions for @enbox/crypto and @enbox/browser
  - Fix typo in dwn-server http-api.ts ("am enbox" → "an enbox")
  - Update code examples in @enbox/auth to use `Enbox.connect()` instead of `new Web5()`

- Updated dependencies [[`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde)]:
  - @enbox/common@0.0.7

## 0.0.7

### Patch Changes

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/common@0.0.6

## 0.0.6

### Patch Changes

- Updated dependencies [[`0eb40d4`](https://github.com/enboxorg/enbox/commit/0eb40d4d111732262de01258c0f7f8c727466714)]:
  - @enbox/common@0.0.5

## 0.0.5

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/common@0.0.4

## 0.0.4

### Patch Changes

- [#202](https://github.com/enboxorg/enbox/pull/202) [`af2ba3a`](https://github.com/enboxorg/enbox/commit/af2ba3a7e9d5de44b40a38169e9296427a4f049b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(crypto): publish updated barrel with algorithm class exports

  The `@enbox/crypto@0.0.3` dist was built before the algorithm barrel
  exports (`AesKwAlgorithm`, `HkdfAlgorithm`, `Pbkdf2Algorithm`,
  `X25519Algorithm`, `EciesSecp256k1`) were added to `index.ts`.
  `@enbox/agent@0.1.4` imports these symbols, causing Vite/Rollup build
  failures in downstream apps (`"AesKwAlgorithm" is not exported`).

  The source was already correct — this bump triggers a fresh publish so
  the dist matches the source.

## 0.0.3

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/common@0.0.3

This package is a fork of the official Web5 Crypto package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/web5-js](https://github.com/decentralized-identity/web5-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
