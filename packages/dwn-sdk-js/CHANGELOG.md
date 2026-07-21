# @enbox/dwn-sdk-js

## 0.4.16

### Patch Changes

- [#1388](https://github.com/enboxorg/enbox/pull/1388) [`7a437b2`](https://github.com/enboxorg/enbox/commit/7a437b2bed8cdb88b30eec86fb6420801845a352) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: subscribe-reply feed snapshot and empty-log anchor cursor

  MessagesSubscribe replies now carry the tenant feed's `head` progress token and scope `fingerprint`, observed after the subscription is active. Empty replication logs return a position-zero anchor cursor from `logRead` in both stores, so empty-feed drains checkpoint instead of re-enumerating every pass. The agent captures both subscription snapshots: matching fingerprints atomically establish the pull and push baselines from their respective heads, while missing or mismatched snapshots run one durable reconciliation before queued callbacks are released.

## 0.4.15

### Patch Changes

- [#1383](https://github.com/enboxorg/enbox/pull/1383) [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Make protocol definitions the sole source of record encryption policy and remove caller-controlled encryption switches. Reject records whose stored representation does not match their type policy, prevent used paths from changing representation under the same protocol URI, and separate encrypted `grantKey` records from plaintext `wrappedGrantKey` envelopes in the core encryption protocol.

## 0.4.14

### Patch Changes

- [#1362](https://github.com/enboxorg/enbox/pull/1362) [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: lossless subscription-decrypt backpressure with acks gated on consumer completion

  The decrypting subscription wrapper returns each event's completion promise — now covering decryption AND the consumer's own (possibly async) processing — and the WebSocket client acks each event, and advances its reconnect cursor, only after that completion resolves, in delivery order. If more than 256 events queue behind in-flight decryption the wrapper terminates losslessly: the overflowing and all later events reject with the new `SubscriptionHandlerTerminalError`, which the WebSocket transport honors by closing the tracked subscription and withholding their acks and cursor advancement, while the consumer receives a synthetic `SubscriptionDecryptBackpressureExceeded` error carrying the last successfully delivered cursor — resubscribing from it replays every dropped event. `SubscriptionListener` and `DwnSubscriptionHandler` now explicitly permit `void | Promise<void>`, and every handler invocation — event delivery and transport lifecycle notifications alike — is normalized through a promise chain: a synchronous throw becomes an observed rejection instead of escaping the socket dispatch or skipping other subscriptions' notifications. `@enbox/browser` also re-exports `AudienceDecryptError`, `AudienceDecryptFailureCause`, and `AudienceKeyDeliveryOutcome` so browser-only apps can classify decrypt failures and delivery outcomes without importing `@enbox/api` directly.

## 0.4.13

### Patch Changes

- [#1339](https://github.com/enboxorg/enbox/pull/1339) [`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: stop config-history repair from purging valid encryption control records

  `ProtocolsConfigure` revalidation fed `$encryption/audience` and `$encryption/delivery` records to the app-definition validator, which cannot recognize their reserved paths — destroying valid audience keys and deliveries on every same-URI policy upgrade. Control records are now revalidated in their own domain: they are purged only when the role path they provision no longer exists in the newest definition.

- [#1341](https://github.com/enboxorg/enbox/pull/1341) [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: make encryption control repair honor governing protocol history

  Stored audience and delivery controls are now replayed against the protocol definition governing their timestamp before newest-role retention is considered. This prevents out-of-order config ingestion from retaining controls that full-history admission would reject, including controls authorized by superseded policy or sealed to a superseded key.

- [#1337](https://github.com/enboxorg/enbox/pull/1337) [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(dwn-sdk-js): BroadcastChannel-bridged event-log wakes for sibling contexts

  New `BroadcastChannelWakePublisher` fans each store wake out to in-process listeners and mirrors it over a named `BroadcastChannel`, so sibling execution contexts sharing one underlying store (browser tabs, workers, a SharedWorker over the same IndexedDB) observe each other's commits immediately instead of waiting for the durable event log's idle re-drain (~30s). Wakes received from the channel are never re-posted (no loops), non-wake traffic is ignored, and environments without `BroadcastChannel` degrade to in-process-only delivery.

  The agent's default message log now derives a channel name from the store location, so local subscriptions in one tab fire promptly when another tab (or a worker) writes — including writes applied by sync running in a different context.

- [#1310](https://github.com/enboxorg/enbox/pull/1310) [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity in DWN handlers/core (Sonar S3776)

  Behavior-preserving extract-method refactoring of 9 functions (CC 16–32) to the ≤15
  threshold — RecordsWrite/RecordsSubscribe handlers, protocol-authorization action
  resolution, integrity validation, message filter conversion, compound-index query,
  storage squash, and delegated-grant integrity. Each extraction lifts a contiguous
  block into a named helper called at the same point; the two non-verbatim transforms
  (one De Morgan negation, one loop `return`/`continue`→boolean-predicate) are
  algebraically exact. No authorization check reordered/weakened; no DwnError code or
  message changed.

  The two monster functions (`interfaces/protocols-configure.ts` CC 122 and
  `handlers/protocols-configure.ts` CC 70) and the `index-level-compound` S107
  parameter-count finding are deferred to dedicated follow-ups.

  Verified: dwn-sdk-js build + lint clean; all 1578 tests pass.

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

- [#1302](https://github.com/enboxorg/enbox/pull/1302) [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve Sonar reliability findings

  - **dwn-sdk-js** (S7746): drop the redundant `Promise.resolve()` wrapper in the async `Secp256r1.sign()`.
  - **auth** (S8786): rewrite the `normalizeErrorText` status-prefix regex with first-character-disjoint separator alternation, eliminating super-linear backtracking. Behavior-preserving (verified equivalent across 36 inputs).
  - **browser** (S2310, S1994): remove loop-counter mutations in the QR encoder — derive the shifted timing column instead of reassigning the counter, and use a `while` + toggle for pad-byte generation. Output is module-for-module identical to the reference encoder.

- [#1356](https://github.com/enboxorg/enbox/pull/1356) [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: structured machine-readable error fields on DWN message replies — reply `status` now carries optional `errorCode` (the `DwnErrorCode` of the originating `DwnError`) and `info` (structured error data, e.g. the squash backstop floor timestamp) so consumers no longer parse `detail` prose

- Updated dependencies [[`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c), [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e)]:
  - @enbox/crypto@0.1.7
  - @enbox/dids@0.1.7
  - @enbox/common@0.1.4

## 0.4.12

### Patch Changes

- Updated dependencies [[`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081)]:
  - @enbox/crypto@0.1.6
  - @enbox/dids@0.1.6

## 0.4.11

### Patch Changes

- [#1267](https://github.com/enboxorg/enbox/pull/1267) [`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: commit latest-state transitions atomically in the message store and resolve retained initial writes by stable entry ID

  `RecordsWrite` and `RecordsDelete` previously stored the new latest message and demoted the retained initial write as two separate store mutations, so concurrent Query/Read/Subscribe could observe two latest-state rows for one record and crashed resolving the initial write through the mutable `isLatestBaseState:false` index — aborting sync. The message store now exposes `commitLatestState`, which applies the insert, retained demotions, and displaced deletions as one atomic commit (a single Level batch / SQL transaction), making the intermediate state unobservable. Readers resolve retained initial writes by the stable identity `entryId === recordId` in one batched lookup; an update whose initial write is genuinely missing (store corruption) is omitted from Query/Subscribe snapshots with a warning, and RecordsRead returns a typed 500.

## 0.4.10

### Patch Changes

- [#1233](https://github.com/enboxorg/enbox/pull/1233) [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: accept `EncryptionControl` dependency refs in replication apply results (previously rejected as malformed, breaking sync recovery of encryption-control dependencies) and remove dead legacy encryption paths: the unproducible `EncryptionProtocol` dependency-ref chain, raw-private-key decrypt/derive overloads superseded by KMS callbacks, the legacy role-epoch schema branch, unused `Delivery`/`GrantKey` precompiled validators, the test-only participant-detection cluster, and orphaned crypto primitives (`EciesSecp256k1`, `ConcatKdf`, plain `XChaCha20`, `AesCtrAlgorithm`, JOSE type duplicates).

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/dids@0.1.5

## 0.4.9

### Patch Changes

- [#1215](https://github.com/enboxorg/enbox/pull/1215) [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve SonarCloud maintainability issues (S3863/S6594)

  Behavior-preserving source cleanups:

  - S3863: merge duplicate `import` statements from the same module into a
    single statement (re-sorting to satisfy the repo's `sort-imports` rule).
  - S6594: use `RegExp.exec()` instead of `String#match()` for the non-global
    route/type regexes in the DWN server and `universalTypeOf`.

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
  - @enbox/dids@0.1.4
  - @enbox/crypto@0.1.4

## 0.4.8

### Patch Changes

- [#1189](https://github.com/enboxorg/enbox/pull/1189) [`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Support wrapped grantKey delivery for pre-supplied delegate DIDs with encrypted read scopes.

## 0.4.7

### Patch Changes

- [#1108](https://github.com/enboxorg/enbox/pull/1108) [`7ddb0d6`](https://github.com/enboxorg/enbox/commit/7ddb0d677065483968ef9d80773e3fd81048f4ad) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Authorize source-protocol encryption control records for read, query, and subscribe operations.

- [#1150](https://github.com/enboxorg/enbox/pull/1150) [`37895ff`](https://github.com/enboxorg/enbox/commit/37895ff511258ed48d10660b1f73ce597e818921) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: reject invalid encryption-control protocol definitions

- [#1105](https://github.com/enboxorg/enbox/pull/1105) [`cda1d31`](https://github.com/enboxorg/enbox/commit/cda1d31b4c8a7df444beadd0271ff50a3482fa00) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add source-protocol encryption control record validation.

- [#1149](https://github.com/enboxorg/enbox/pull/1149) [`5de6973`](https://github.com/enboxorg/enbox/commit/5de6973f98216a3732800a6ec461520b47171902) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Project audience control enumeration to the deterministic current key per role-audience tuple.

- [#1121](https://github.com/enboxorg/enbox/pull/1121) [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: dedupe runtime dependency versions and pin dependency declarations

- [#1120](https://github.com/enboxorg/enbox/pull/1120) [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency footprint by moving optional backends behind subpath imports and optional peer dependencies, removing unused DID and helper packages, and replacing small CLI/runtime dependencies with built-in implementations.

- [#1101](https://github.com/enboxorg/enbox/pull/1101) [`042879e`](https://github.com/enboxorg/enbox/commit/042879ea1e05d45b99ab35e23f1ab2f730afa757) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add foundation schemas and reserved path types for source-protocol encryption control records.

- [#1102](https://github.com/enboxorg/enbox/pull/1102) [`efa5171`](https://github.com/enboxorg/enbox/commit/efa5171b36aa0f46e957e74506323f9cbd4d8dc7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Reserve encryption control write paths for protocol-native validation.

- [#1103](https://github.com/enboxorg/enbox/pull/1103) [`97dced6`](https://github.com/enboxorg/enbox/commit/97dced6b0eb80fccbd71ea5a8a1c250ba40153bb) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Restrict grantKey records to Records.Read permission grants.

- [#1106](https://github.com/enboxorg/enbox/pull/1106) [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: expand durable grantKey coverage for role-path encryption keys

- [#1146](https://github.com/enboxorg/enbox/pull/1146) [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: isolate Level-backed DWN and DID store implementations behind explicit subpath exports

- [#1098](https://github.com/enboxorg/enbox/pull/1098) [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: make DWN key wrapping algorithm-discriminated

- [#1136](https://github.com/enboxorg/enbox/pull/1136) [`23ae738`](https://github.com/enboxorg/enbox/commit/23ae7389a4c14aedf360c5b3b3bbdd8c274ef53a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: treat Messages surfaces as encrypted control-record transport

- [#1109](https://github.com/enboxorg/enbox/pull/1109) [`b38dd5e`](https://github.com/enboxorg/enbox/commit/b38dd5ec24129a37e8e2bb17b3173144ac9bb863) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: enforce encryption control record visibility on Messages read and feed surfaces

- [#1156](https://github.com/enboxorg/enbox/pull/1156) [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove the legacy epoch-based role-audience encryption path and pin sealed-audience end-to-end coverage.

- [#1141](https://github.com/enboxorg/enbox/pull/1141) [`96bc5f5`](https://github.com/enboxorg/enbox/commit/96bc5f5c2d80f0cb543042e3f41f5c2d4156c3d3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: replace Temporal polyfill usage with native timestamp utilities.

- [#1138](https://github.com/enboxorg/enbox/pull/1138) [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: admit source-protocol role-audience encryption entries

- [#1154](https://github.com/enboxorg/enbox/pull/1154) [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove role-creator audience delivery paths and require seal-covered audience minting.

- [#1151](https://github.com/enboxorg/enbox/pull/1151) [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: replace delegate response key delivery with sealed audience control records

- [#1135](https://github.com/enboxorg/enbox/pull/1135) [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency surface for SDK cache, wake publisher, server logging, and SQL store manifests.

- [#1155](https://github.com/enboxorg/enbox/pull/1155) [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: share sealed audience key wrapping and agent read-through helpers

- [#1143](https://github.com/enboxorg/enbox/pull/1143) [`57c66a3`](https://github.com/enboxorg/enbox/commit/57c66a34079625793c8b26028f29d1eb63b969ef) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: derive role-audience dependency repair from structured context

- Updated dependencies [[`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`78cd3e5`](https://github.com/enboxorg/enbox/commit/78cd3e5b8412b308077f318b58bf5fd3db63d996), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46)]:
  - @enbox/dids@0.1.3
  - @enbox/common@0.1.2
  - @enbox/crypto@0.1.3

## 0.4.6

### Patch Changes

- [#1095](https://github.com/enboxorg/enbox/pull/1095) [`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor encryption key material and key wrapping abstractions

## 0.4.5

### Patch Changes

- [#1080](https://github.com/enboxorg/enbox/pull/1080) [`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: complete DWN encryption storage lookup and remove legacy encryption surface

- [#1077](https://github.com/enboxorg/enbox/pull/1077) [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: implement DWN encryption v1 records, protocol keys, and delegate key delivery

- [#1087](https://github.com/enboxorg/enbox/pull/1087) [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add initial role-audience encryption key delivery and decryption support. Epoch rotation for membership changes remains tracked separately.

- Updated dependencies [[`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37)]:
  - @enbox/crypto@0.1.2
  - @enbox/dids@0.1.2

## 0.4.4

### Patch Changes

- [#1072](https://github.com/enboxorg/enbox/pull/1072) [`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add bounded, display-only connect session metadata to permission grants and default connect-created grants to a hard 24-hour expiration.

## 0.4.3

### Patch Changes

- [#1070](https://github.com/enboxorg/enbox/pull/1070) [`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use `Records.Read` as the canonical read-like records permission for read, query, subscribe, and count operations. Connect requests now emit only read/write/delete record permissions, reject obsolete record query/subscribe/count grant scopes, and keep protocol configuration wallet-owned instead of delegating `Protocols.Configure` to apps. Delegate `TypedEnbox` auto-configuration imports the wallet's signed protocol configuration locally instead of requiring a delegated configure grant.

## 0.4.2

### Patch Changes

- [#1066](https://github.com/enboxorg/enbox/pull/1066) [`05f5621`](https://github.com/enboxorg/enbox/commit/05f56216adcbdba09ae039238055a4591674ef88) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(dwn-sdk-js): validate protocol tags without runtime Ajv compilation

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
