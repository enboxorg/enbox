# @enbox/browser

## 0.3.61

### Patch Changes

- Updated dependencies [[`bad337e`](https://github.com/enboxorg/enbox/commit/bad337e27a7f5e1029780401a419bc5c313c03ff), [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3), [`6688e32`](https://github.com/enboxorg/enbox/commit/6688e327e27d52a55d6daabdcfe1195f2954a67a)]:
  - @enbox/agent@0.8.31
  - @enbox/api@0.6.69
  - @enbox/dwn-sdk-js@0.4.15
  - @enbox/auth@0.6.77
  - @enbox/protocols@0.2.96
  - @enbox/connect@0.1.11

## 0.3.60

### Patch Changes

- [#1375](https://github.com/enboxorg/enbox/pull/1375) [`ac8581d`](https://github.com/enboxorg/enbox/commit/ac8581d3ac7f569c17bc2b22d3af3fa2e8921530) Thanks [@poindex-bot](https://github.com/poindex-bot)! - chore: update the default wallet list — replace Onyx with Sumi, and add Quay and Quoin.

- Updated dependencies [[`257fa11`](https://github.com/enboxorg/enbox/commit/257fa11e014b59a758e93dcdeb8dec9b6deb989b), [`da812fc`](https://github.com/enboxorg/enbox/commit/da812fcfd501f4135682683f2960793c0ad37d26), [`83020bd`](https://github.com/enboxorg/enbox/commit/83020bdcf86e4db86f00f877c88427fc7e36f7bc), [`8b9ab70`](https://github.com/enboxorg/enbox/commit/8b9ab7017d5ac9d37920249c54d75264cad1fe99), [`3804b5d`](https://github.com/enboxorg/enbox/commit/3804b5dc1ddb94cd7beaff7045345efd474f6965), [`b334497`](https://github.com/enboxorg/enbox/commit/b33449751d36dd5c3bfddce7d208c75a9418bf50), [`08c6912`](https://github.com/enboxorg/enbox/commit/08c69121ecdfcfe2adc7758e7242d28b894caa95)]:
  - @enbox/agent@0.8.30
  - @enbox/auth@0.6.76
  - @enbox/api@0.6.68
  - @enbox/protocols@0.2.95

## 0.3.59

### Patch Changes

- [#1362](https://github.com/enboxorg/enbox/pull/1362) [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: lossless subscription-decrypt backpressure with acks gated on consumer completion

  The decrypting subscription wrapper returns each event's completion promise — now covering decryption AND the consumer's own (possibly async) processing — and the WebSocket client acks each event, and advances its reconnect cursor, only after that completion resolves, in delivery order. If more than 256 events queue behind in-flight decryption the wrapper terminates losslessly: the overflowing and all later events reject with the new `SubscriptionHandlerTerminalError`, which the WebSocket transport honors by closing the tracked subscription and withholding their acks and cursor advancement, while the consumer receives a synthetic `SubscriptionDecryptBackpressureExceeded` error carrying the last successfully delivered cursor — resubscribing from it replays every dropped event. `SubscriptionListener` and `DwnSubscriptionHandler` now explicitly permit `void | Promise<void>`, and every handler invocation — event delivery and transport lifecycle notifications alike — is normalized through a promise chain: a synchronous throw becomes an observed rejection instead of escaping the socket dispatch or skipping other subscriptions' notifications. `@enbox/browser` also re-exports `AudienceDecryptError`, `AudienceDecryptFailureCause`, and `AudienceKeyDeliveryOutcome` so browser-only apps can classify decrypt failures and delivery outcomes without importing `@enbox/api` directly.

- Updated dependencies [[`9dd09a6`](https://github.com/enboxorg/enbox/commit/9dd09a6d76a98eb54da813b1a3dc9b648527f7f3), [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca)]:
  - @enbox/agent@0.8.29
  - @enbox/dwn-sdk-js@0.4.14
  - @enbox/api@0.6.67
  - @enbox/auth@0.6.75
  - @enbox/protocols@0.2.94
  - @enbox/connect@0.1.10

## 0.3.58

### Patch Changes

- [#1355](https://github.com/enboxorg/enbox/pull/1355) [`cd6940e`](https://github.com/enboxorg/enbox/commit/cd6940e28434cac31587bd2745ce3411d670bfa3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add a framework-agnostic connection store and a typed connect-denied error

  - `@enbox/auth`: connect, refresh, and wallet-connect denials now throw a typed `ConnectDeniedError` (messages unchanged); branch on the new `isConnectDeniedError()` predicate instead of string-matching error messages.
  - `@enbox/api`: new `createConnectionStore()` — a headless, subscribable store that composes `AuthManager` + `Enbox` into one observable state machine (`initializing | disconnected | connecting | connected | error`), with `getSnapshot()`/`subscribe()` for `useSyncExternalStore`-style bindings, in-flight guards, delegated connection monitoring, and `dispose()` teardown.
  - `@enbox/browser`: re-exports `createConnectionStore`, its types, `ConnectDeniedError`, and `isConnectDeniedError`.

- [#1353](https://github.com/enboxorg/enbox/pull/1353) [`ab5d3c9`](https://github.com/enboxorg/enbox/commit/ab5d3c940ab4edd4c81fc18303084ee22632d14b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add `createProfileReader` — a cached read layer for other users' public profiles

  `@enbox/protocols` now ships a profile reader implementing the fetch shape wallets write: one records query for the published profile JSON singleton plus direct anyone-read `RecordsRead`s for the unpublished avatar/hero image singletons. It provides `get()`, refcounted `watch()` with field-level settlement, `getSnapshot()` for `useSyncExternalStore`-style bindings, a retry ladder for retryable statuses (401/403/408/410/425/429/5xx + transport errors), access-driven negative caching, bounded fetch concurrency, idle release, and an injectable clock. Works over a connected records surface (`DwnApi` from `@enbox/api/advanced`) and over `Enbox.anonymous()`. `@enbox/browser` re-exports the reader for batteries-included dapp setups.

  Profile JSON is treated as untrusted input: fields are validated against a strict allowlist (string-valued `displayName`/`bio`/`tagline`/`location`/`website`/`pronouns` only) and the requested DID plus separately-fetched image Blobs always win over anything in the JSON. Images load lazily by default (`images: 'eager' | 'lazy' | 'off'`, `loadImages()` on demand), are fetched only after the root profile record is confirmed (orphaned avatar/hero records left by non-pruning deletes are suppressed), are size-validated against the protocol maxima before and after download, and retained Blobs are bounded by a configurable LRU byte budget (default 128 MiB).

- [#1283](https://github.com/enboxorg/enbox/pull/1283) [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(agent): graceful, self-healing handling of quota-blocked sync pushes + observable per-remote sync status

  Sync pushes rejected for tenant storage/message quota are no longer retried forever (the console-error flood that spun the remote). They are now detected precisely (`isQuotaExceededError`, newly exported from `@enbox/dwn-clients`) and deferred on a per-link, per-message exponential-backoff probe. Feed checkpoints may advance past the explicit omission, so a blocked message neither stalls newer records nor prevents other remotes from progressing; due and manual retries target the omitted CID independently of that checkpoint. If a later update or tombstone makes the old bytes unreachable, its acknowledgement converts the block into a resolved per-link omission: it is healthy, never retried, and remains durable only long enough to explain the intentional feed-CID difference.

  Live sync now suppresses the remote subscription echo of messages already materialized in the same local tenant when it pushes them to that endpoint. The matching pull delivery still advances its durable checkpoint, but it no longer performs a redundant remote `MessagesRead` or re-applies data already present in the local DWN; tenant- and endpoint-scoped tracking preserves multi-identity isolation and normal multi-provider fan-out. Canonicalized bootstrap messages that may not exist in the destination tenant still follow normal pull admission. Pull deliveries accepted while a link is still initializing are also committed, preventing an early event from pinning every later checkpoint behind an unfinished ordinal.

  Replicated metadata-only historical writes continue through storage-quota preflight without charging their declared payload size, while message-count quota and all normal data-bearing quota checks remain enforced. This lets a later tombstone or smaller update replay its retained initial-write dependency without exposing a dataless current record. Same-CID data retries against ancestry-only storage are deferred instead of falsely acknowledged, embedded message data is rejected in favor of the validated transport field, and storage reporting now counts only latest base-state data rather than metadata-only history.

  New observability, re-exported through `@enbox/browser` for dapp "remotes" panels: `SyncEngine.getRemoteSyncStatus()` returns a per-`(tenant, remote)` snapshot (`healthy | quota-blocked | degraded | offline`, blocked count, next-probe time, last error/activity); `SyncEngine.retryRemoteNow()` directly re-probes only the selected remote; `push:quota-blocked` / `push:quota-cleared` events include durable timing and clear resolution; and `SyncHealthSummary` gains `quotaBlockedMessageCount`.

  Also fixes a latent bug in the push dependency-fetch path: the four local dependency queries (`fetchProtocolConfig`, `fetchRecordsByRecordId`, `fetchRoleRecord`, `fetchRecordData`) passed `store: false`, which makes `AgentDwnApi.processRequest` short-circuit to a synthetic `202` reply with no entries instead of executing the query — so every attempt to satisfy a remote `Incomplete` missing-dependency from the local DWN silently returned `failed`. Dropping `store: false` lets those local queries run (read/query handlers persist nothing, so there is no side effect). The bug was masked because unit tests stub `processRequest`; the added live-sync/quota convergence coverage now exercises the real path.

- [#1334](https://github.com/enboxorg/enbox/pull/1334) [`b51e9f6`](https://github.com/enboxorg/enbox/commit/b51e9f62554130eedc39adb7be6d81c4d2c281f9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: move the DWeb Connect transports' rejection-handled markers out of their constructors

  Extracts a `createHandledDeferred` helper so the no-op `.catch()` that
  pre-marks early rejections as handled no longer runs inside the
  `PopupClientTransport` / `WalletPostMessageTransport` constructors
  (Sonar S7059). No behavior change.

- [#1311](https://github.com/enboxorg/enbox/pull/1311) [`fde5189`](https://github.com/enboxorg/enbox/commit/fde51894405fe095a6a19a179690dd1956222de1) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity and nesting in browser UI (Sonar S3776/S2004)

  Behavior-preserving refactoring: extract-method on `encodeQr`, `drawCodewords`,
  `runRelayConnect`, and the DRL click handler (S3776), plus hoisting six deeply-nested
  closures in `connect-modal.ts` to module-level helpers (`settleWith`, `buildPinInputs`,
  reuse of `walletInCatalog`) to satisfy S2004. All new helpers are module-private; no
  public API signature changed. The QR encoder's output is unchanged (verified module-
  for-module against the reference encoder), the relay PIN-retry loop preserves its exact
  rethrow/continuation semantics (and `this` binding for `confirmComplete`), and the
  mutable `pinResolve` state is proxied so reads/clears still hit the live variable.

  Defers `qr.ts:409` (CC 40).

  Verified: browser build + lint clean; qr oracle tests pass (module-for-module);
  remaining UI behavior covered by the CI browser (Vitest) suite.

- [#1316](https://github.com/enboxorg/enbox/pull/1316) [`777ca53`](https://github.com/enboxorg/enbox/commit/777ca536b2edb26abe7d2da36e17c760844817ca) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity of the QR mask-penalty function (Sonar S3776)

  Behavior-preserving refactoring of `computePenalty` in the vendored QR-code generator
  (was CC 40) to ≤15 by extracting the four QR mask-penalty rules (N1 adjacent runs,
  N2 2×2 blocks, N3 finder-like patterns, N4 dark-module ratio) into module-level
  helpers, summed in the same order. Every loop bound, weight/threshold constant, the
  finder-pattern bit array, and the integer arithmetic are byte-for-byte unchanged.

  Verified: browser build + lint clean; the QR encoder's output is unchanged
  module-for-module vs. the reference encoder (mask selection depends on this penalty).

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

- [#1320](https://github.com/enboxorg/enbox/pull/1320) [`9a43745`](https://github.com/enboxorg/enbox/commit/9a43745ab929f81231bdd22f1b029238f4bccc42) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: await the popup promise inside its try so failures are handled uniformly (Sonar S4822)

  `startPopup` invoked `deps.runPopup(...)` and attached `.then/.catch/.finally` inside a
  try/catch. S4822 flags a promise-returning call sitting inside a try that is neither
  awaited nor chained there — the try appears to guard the popup's failure but doesn't
  (the rejection is handled by `.catch`, the try only catches a synchronous throw).

  Fix per the rule's guidance: make `startPopup` async and `await deps.runPopup(...)`
  inside the try. `runPopup` is still invoked synchronously (its `window.open` runs before
  the first await, preserving the user-gesture popup open), and the single try/catch/finally
  now handles both a synchronous throw (a custom transport) and an async rejection, resetting
  `popupBusy` in `finally`. Behavior is unchanged (verified against the existing popup
  success/denied/closed/blocked/timeout/sync-throw tests).

  This clears the last open bug, restoring the project's Reliability rating to A.

- [#1302](https://github.com/enboxorg/enbox/pull/1302) [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve Sonar reliability findings

  - **dwn-sdk-js** (S7746): drop the redundant `Promise.resolve()` wrapper in the async `Secp256r1.sign()`.
  - **auth** (S8786): rewrite the `normalizeErrorText` status-prefix regex with first-character-disjoint separator alternation, eliminating super-linear backtracking. Behavior-preserving (verified equivalent across 36 inputs).
  - **browser** (S2310, S1994): remove loop-counter mutations in the QR encoder — derive the shifted timing column instead of reassigning the counter, and use a `while` + toggle for pad-byte generation. Output is module-for-module identical to the reference encoder.

- Updated dependencies [[`c4ee0bc`](https://github.com/enboxorg/enbox/commit/c4ee0bc057fb5b2278926fe1d9d1add618acc08d), [`6ad8f08`](https://github.com/enboxorg/enbox/commit/6ad8f08b2b87a9915ddbc6b289284a2b6635fbbd), [`48149b9`](https://github.com/enboxorg/enbox/commit/48149b970383af60d1113019c7a54b3f26cdd24c), [`851ffb4`](https://github.com/enboxorg/enbox/commit/851ffb40396e710b596463c62b055034b3882fad), [`1774805`](https://github.com/enboxorg/enbox/commit/1774805f09934ff839c3008bfcbf2bf4fff04963), [`16c8ea4`](https://github.com/enboxorg/enbox/commit/16c8ea46380d303fb20eeec7047b5f1f286f661f), [`3e6d5fe`](https://github.com/enboxorg/enbox/commit/3e6d5fe51f3ae16db0c08174132bcdc828f15c93), [`e83cb4b`](https://github.com/enboxorg/enbox/commit/e83cb4b05e7f184e515ccd547f5ac1c346fea045), [`f41a755`](https://github.com/enboxorg/enbox/commit/f41a755adfe769ad1ca5b00b7275059f2ed2305e), [`73a76e1`](https://github.com/enboxorg/enbox/commit/73a76e1099ebfb6b8e399431541a43d14d3df5ec), [`8f6cc7d`](https://github.com/enboxorg/enbox/commit/8f6cc7de740771a15a7eb1732d0597b2082fb347), [`d5c8e83`](https://github.com/enboxorg/enbox/commit/d5c8e8300ffb30ba89580ea0a37c3f9513470572), [`3309d87`](https://github.com/enboxorg/enbox/commit/3309d87efdea35ca784917b3b0ec05362a4a7c81), [`7f4c4e7`](https://github.com/enboxorg/enbox/commit/7f4c4e7b485f47b8cf0d6c40d60054363f4c56e3), [`a40eb11`](https://github.com/enboxorg/enbox/commit/a40eb11831bd9e669ed1a6b5dca58274be82d9de), [`e33cf82`](https://github.com/enboxorg/enbox/commit/e33cf820fec511d09676f5ea5473fa6db8727c5f), [`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441), [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`8d59d0b`](https://github.com/enboxorg/enbox/commit/8d59d0b39e7d0cfefdb4a416da669aa77a69cda7), [`cd6940e`](https://github.com/enboxorg/enbox/commit/cd6940e28434cac31587bd2745ce3411d670bfa3), [`ab5d3c9`](https://github.com/enboxorg/enbox/commit/ab5d3c940ab4edd4c81fc18303084ee22632d14b), [`757cff1`](https://github.com/enboxorg/enbox/commit/757cff17cbb8bec36f806eec1a8ee3606f3c9ae2), [`2b50952`](https://github.com/enboxorg/enbox/commit/2b5095252fc621d6ea35db5a330759009c2a88e2), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`9889d7d`](https://github.com/enboxorg/enbox/commit/9889d7dcaf9fb53d2da7efea08b8d3c3f173932e), [`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c), [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67), [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`d6f72b4`](https://github.com/enboxorg/enbox/commit/d6f72b4ec9f50fd86f288021416c7f22a61c60ed), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`4c32046`](https://github.com/enboxorg/enbox/commit/4c320469d38f4f67c51ad6b82edca397fc0bd4c2), [`4498e5a`](https://github.com/enboxorg/enbox/commit/4498e5ad249bb38e24047d1665b6a19849f5c8a9), [`132cd4a`](https://github.com/enboxorg/enbox/commit/132cd4ad25c428991e60ea52f2871457169e9072), [`48fde39`](https://github.com/enboxorg/enbox/commit/48fde39d5857f8b7bb70ddbfc857ad276e49d27c), [`74dd445`](https://github.com/enboxorg/enbox/commit/74dd445b283e476eb3c26d6fbd3f193c32fa924e), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0), [`76be6bb`](https://github.com/enboxorg/enbox/commit/76be6bba0e0f7a3ae25ee1829915974581960982), [`9e4be6d`](https://github.com/enboxorg/enbox/commit/9e4be6de0206e0c3e2cbd5e235405cffef75e1bc), [`b964d48`](https://github.com/enboxorg/enbox/commit/b964d48ab993934337c348f6655e9923bfa409f3), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`c7d1b82`](https://github.com/enboxorg/enbox/commit/c7d1b8265a73134cd55a6330b29d1ede137302c4), [`d564725`](https://github.com/enboxorg/enbox/commit/d564725121d6488eea74790cb5279b505ff09dc9), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`d275b31`](https://github.com/enboxorg/enbox/commit/d275b31fb738a8f2aa2744dd14a4090481d2c9f4), [`418030a`](https://github.com/enboxorg/enbox/commit/418030a14cd84a889a57aefe0237e5a2f2c39395), [`5b4e0d3`](https://github.com/enboxorg/enbox/commit/5b4e0d305ab9c142111ba8ec553a4d4bd18a8ff7), [`dd311d4`](https://github.com/enboxorg/enbox/commit/dd311d4459a8da2b1c6e0b233c10a5fa299e6548), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`024cd55`](https://github.com/enboxorg/enbox/commit/024cd5592e5cecfbdea348747deb34da9ba21b94), [`b5f49ac`](https://github.com/enboxorg/enbox/commit/b5f49ace4e6ab9e1caf23afb2cdd8735d44985b3)]:
  - @enbox/agent@0.8.28
  - @enbox/api@0.6.66
  - @enbox/dwn-sdk-js@0.4.13
  - @enbox/auth@0.6.74
  - @enbox/protocols@0.2.93
  - @enbox/crypto@0.1.7
  - @enbox/dids@0.1.7
  - @enbox/connect@0.1.9
  - @enbox/common@0.1.4

## 0.3.57

### Patch Changes

- Updated dependencies [[`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131)]:
  - @enbox/agent@0.8.27
  - @enbox/api@0.6.65
  - @enbox/auth@0.6.73

## 0.3.56

### Patch Changes

- Updated dependencies [[`f18cece`](https://github.com/enboxorg/enbox/commit/f18ceceeae21b85aa9898decffe479f6fb729bff)]:
  - @enbox/connect@0.1.8
  - @enbox/agent@0.8.26
  - @enbox/auth@0.6.72
  - @enbox/api@0.6.64

## 0.3.55

### Patch Changes

- [#1276](https://github.com/enboxorg/enbox/pull/1276) [`0a5cc42`](https://github.com/enboxorg/enbox/commit/0a5cc42c1d8920e6ba9326d6331b3b119c9e7892) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: abort abandoned relay polling when browser connect sessions are superseded or dismissed

- Updated dependencies [[`0a5cc42`](https://github.com/enboxorg/enbox/commit/0a5cc42c1d8920e6ba9326d6331b3b119c9e7892)]:
  - @enbox/connect@0.1.7
  - @enbox/agent@0.8.25
  - @enbox/auth@0.6.71
  - @enbox/api@0.6.63

## 0.3.54

### Patch Changes

- [#1274](https://github.com/enboxorg/enbox/pull/1274) [`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83) Thanks [@poindex-bot](https://github.com/poindex-bot)! - Add delegated connect-session status, expiry error helpers, opt-in monitoring, and same-delegate grant refresh across the auth and browser APIs. Refresh requests now carry an explicit wallet UI signal, reuse the existing delegate keys on popup and relay transports, and select fresh active grants over expired or superseded grants. Connect results now fail closed when grants come from the wrong owner, exceed the requested scope, or contain no usable requested grant.

- Updated dependencies [[`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83)]:
  - @enbox/agent@0.8.24
  - @enbox/connect@0.1.6
  - @enbox/auth@0.6.70
  - @enbox/api@0.6.62

## 0.3.53

### Patch Changes

- Updated dependencies [[`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081)]:
  - @enbox/crypto@0.1.6
  - @enbox/agent@0.8.23
  - @enbox/api@0.6.61
  - @enbox/auth@0.6.69
  - @enbox/connect@0.1.5
  - @enbox/dids@0.1.6
  - @enbox/dwn-sdk-js@0.4.12

## 0.3.52

### Patch Changes

- [#1269](https://github.com/enboxorg/enbox/pull/1269) [`b54b98c`](https://github.com/enboxorg/enbox/commit/b54b98c91f1ca26bc402f5163e739eb1f830a10c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: show popup recovery when browsers reject a blocked wallet popup

## 0.3.51

### Patch Changes

- [#1265](https://github.com/enboxorg/enbox/pull/1265) [`ea9f6cd`](https://github.com/enboxorg/enbox/commit/ea9f6cdb00ae265ac11f1b6e70c8dbe8bca7491e) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix(connect): widen the QR re-mint safety margin to 120s so a scanned code survives the wallet unlock ceremony

  The relay pointer is single-use with a TTL that starts at mint time, but a
  returning-but-locked wallet only dereferences it after the user unlocks. A
  30s margin left codes on screen that could die between the scan and the
  post-unlock fetch, surfacing as a dead-end 404 in the wallet.

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11
  - @enbox/agent@0.8.22
  - @enbox/api@0.6.60
  - @enbox/auth@0.6.68
  - @enbox/connect@0.1.4

## 0.3.50

### Patch Changes

- [#1263](https://github.com/enboxorg/enbox/pull/1263) [`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: bidirectional completion signals for the connect handshake. The relay gains an observational completion marker (`POST /connect/complete` + `GET /connect/complete/{state}`, mirroring the claimed marker): clients signal it automatically after successfully opening the wallet's response (`ConnectTransport.confirmComplete`, wired into `ConnectClient` and the browser relay runner, `keepalive` so it survives immediate navigation), and wallets can poll `pollRelayComplete` to flip their pairing screen to a confirmed "connected" state instead of asking the user to dismiss it blind. The popup channel gets the same signal as a payload-less `enbox-connect-ack` postMessage: dapps send it automatically, and wallets can await it via `WalletPostMessageTransport.sendResponseAwaitingAck` to show confirmed success before closing themselves. All signals are best-effort and backward compatible — older relays, wallets, and dapps simply never see them. The relay's connect store now awaits its TTL-cache writes and deletes, closing a race where the PAR response could outrun the request insert (a wallet dereferencing the pointer immediately read a false 404) and hardening the single-use pointer guarantee.

- [#1263](https://github.com/enboxorg/enbox/pull/1263) [`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(browser): smoother same-device connect handoff. The connect modal's QR is now itself a handoff link and stays on screen on phones next to the Continue button; both open the wallet in a new tab (instead of navigating away) so the session — and the pairing-code entry — is waiting when the user switches back. Relay polling now resumes the instant the tab returns to the foreground, missed re-mints fire on return, and a wallet popup that posts its response and immediately closes itself no longer races into a false denial, and the wallet popup now opens centred over the calling window instead of wherever the browser parks it.

- Updated dependencies [[`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919)]:
  - @enbox/connect@0.1.3
  - @enbox/agent@0.8.21
  - @enbox/auth@0.6.67
  - @enbox/api@0.6.59

## 0.3.49

### Patch Changes

- [#1261](https://github.com/enboxorg/enbox/pull/1261) [`74f1e9b`](https://github.com/enboxorg/enbox/commit/74f1e9ba2fe6fccdbbc7990e9b830dd94f067541) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(browser): dedupe the expanded wallet grid, unify tile sizing, cap grid height; add Taffy + Astoria

  The connect modal's expanded panel now lists only the wallets not already
  visible in the identity row, so a wallet is never shown twice and the More
  tile's +N count equals the grid size exactly. Grid tiles share the identity
  row's tile recipe on a matching four-column grid, the grid caps at three rows
  and scrolls in place with a bottom-fade hint that clears at the end of the
  list, and the search threshold applies to the grid subset. Taffy and Astoria
  join the default wallet catalog.

## 0.3.48

### Patch Changes

- Updated dependencies [[`672a13f`](https://github.com/enboxorg/enbox/commit/672a13fd33dde00afdf8fd4fe2de649f06a1b93f)]:
  - @enbox/agent@0.8.20
  - @enbox/api@0.6.58
  - @enbox/auth@0.6.66

## 0.3.47

### Patch Changes

- [#1257](https://github.com/enboxorg/enbox/pull/1257) [`17d8074`](https://github.com/enboxorg/enbox/commit/17d8074a623897a5212add222c40480d5ef30ab8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(browser): wallet identity row and QR-centre wallet logo in the connect modal

  The footer's text-only wallet disclosure becomes a "Connecting with" row of
  wallet tiles — the selected wallet plus the next catalog wallets (never
  repeating one), with a More tile that expands the full searchable catalog and
  custom-URL entry in place and collapses back on selection. The selected
  wallet's mark is centred on the QR (well within ECC-M's recovery budget) and
  named in the stage copy, and the mobile deep link reads "Continue in
  {wallet}".

## 0.3.46

### Patch Changes

- [#1255](https://github.com/enboxorg/enbox/pull/1255) [`427eb8c`](https://github.com/enboxorg/enbox/commit/427eb8c4559fce85f59937384fbd6eb0e538bdba) Thanks [@poindex-bot](https://github.com/poindex-bot)! - Connect modal design pass: the wallet switcher becomes a square tile grid with a search bar past one row, the footer collapses to a single row, and the whole surface tightens vertically. The modal now follows the visitor's system light/dark appearance live, and apps can pass an optional `theme` (forced appearance, brand accent, per-scheme palette tokens). Also repairs a stylesheet nesting slip that left the wallet panel permanently expanded and the phone-connected pulse unstyled.

## 0.3.45

### Patch Changes

- [#1253](https://github.com/enboxorg/enbox/pull/1253) [`7e5f7ec`](https://github.com/enboxorg/enbox/commit/7e5f7ec504c8c4f552348c6a091fad389a408a45) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(connect): relay claimed signal — apps can show "phone connected" while waiting for approval

  - **dwn-server**: fetching a pushed connect request now records a
    non-consuming `claimed` marker (same TTL), exposed via
    `GET /connect/status/:requestId` → `{ claimed: boolean }`. The marker is
    keyed by the request ID the app already holds, reveals nothing about the
    request (deleted on fetch), and unknown/expired IDs read as `false`.
  - **connect**: `RelayClientTransport` accepts `onClaimed`, fired once from
    the `awaitResponse()` poll loop when the relay reports the claim. Status
    polling only happens when the callback is provided; relays without the
    route degrade silently.
  - **browser**: the connect modal's QR stage morphs to "Phone connected —
    finish there" the moment the wallet fetches the request, and stops
    re-minting the QR so the in-flight approval is never orphaned.

- Updated dependencies [[`7e5f7ec`](https://github.com/enboxorg/enbox/commit/7e5f7ec504c8c4f552348c6a091fad389a408a45)]:
  - @enbox/connect@0.1.2
  - @enbox/agent@0.8.19
  - @enbox/auth@0.6.65
  - @enbox/api@0.6.57

## 0.3.44

### Patch Changes

- [#1251](https://github.com/enboxorg/enbox/pull/1251) [`5e71fe9`](https://github.com/enboxorg/enbox/commit/5e71fe92c035c635717ab870029ee1fb5fa5c553) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(browser): connect modal owns the whole session — phone-first QR, pairing code, popup fallback

  `enbox.connect()` in the browser now drives the entire wallet handshake from a
  single modal instead of handing off to a wallet-selector-then-popup sequence:

  - **Phone-first by default.** The modal immediately mints a relay request and
    shows a QR code for the user's phone wallet (a tappable deep link on mobile).
    The pairing-code prompt, success, denial, timeout, and error states all render
    in the same surface — no window juggling.
  - **Popup still one click away.** "Use this browser instead" runs the existing
    popup flow, opened synchronously inside the click so popup blockers stay
    quiet. The last successful method + wallet are remembered (`localStorage`)
    and pre-selected next time; a remembered popup choice renders a prompt and
    never auto-opens a window.
  - **Wallet switching stays in place.** A footer disclosure lists the wallet
    catalog and accepts a custom wallet URL, validated against the wallet's
    `/.well-known/enbox-connect` document (same machinery as
    the former standalone selector, which this replaces). Switching wallets re-mints the
    request for the new wallet.
  - New exports: `runConnectModal`, `discoverWalletConnectServerUrl`,
    `runRelayConnect` (relay handshake with interactive pairing-code retry),
    `fetchWalletWellKnown`, and a dependency-free QR encoder
    (`encodeQr`/`qrToSvg`, byte mode, ECC M, versions 1–10).
  - `EnboxConnectOptions` gains `preferredMethod`, `rememberChoice`,
    `connectServerUrl`, and `relayWalletPath`.

  Removed: `showWalletSelector` and `WalletSelectorOptions`. The connect modal
  is the single connect surface; its wallet switcher absorbs the selector's
  quick-connect, favicon/letter-badge tiles, search filter, and
  well-known-validated custom URL (with explicit override). The discovery
  helpers stay public, now from `ui/wallet-well-known`: `fetchWalletWellKnown`,
  `probeWalletWellKnown`, `WALLET_WELL_KNOWN_PATH`, `WalletWellKnownDocument`.

## 0.3.43

### Patch Changes

- [#1249](https://github.com/enboxorg/enbox/pull/1249) [`95ff115`](https://github.com/enboxorg/enbox/commit/95ff11501400dbd0786f14e769d50b833a8a871d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(browser): re-export common symbols so dapps need fewer packages

  `@enbox/browser` now re-exports the handful of symbols dapps most commonly
  reached into sibling packages for, so that in most cases a dapp only needs
  `@enbox/browser` (plus `@enbox/protocols` for shared protocol definitions):

  - `TypedRecord` (from `@enbox/api`)
  - `BrowserStorage`, `ProviderAuthParams`, `ProviderAuthResult` (from `@enbox/auth`)
  - `DwnInterface` (from `@enbox/agent`)
  - `DateSort`, `DwnInterfaceName`, `DwnMethodName`, `ProtocolDefinition`,
    `ProtocolActionRule` (from `@enbox/dwn-sdk-js`)

  These are additive re-exports; anything more specialized is still available by
  importing the underlying package directly.

- Updated dependencies [[`95ff115`](https://github.com/enboxorg/enbox/commit/95ff11501400dbd0786f14e769d50b833a8a871d)]:
  - @enbox/agent@0.8.18
  - @enbox/api@0.6.56
  - @enbox/auth@0.6.64

## 0.3.42

### Patch Changes

- [#1246](https://github.com/enboxorg/enbox/pull/1246) [`468c272`](https://github.com/enboxorg/enbox/commit/468c2727ce729302d161adc8280cdb81f15d27e3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(browser): redesign the wallet connect dialog

  `showWalletSelector` (used by `BrowserConnectHandler`, so every dapp gets it by
  default) is now a single modal with three zones:

  - **Quick connect** — one-tap connect with the recommended (first) wallet.
  - **Wallet grid** — a scrollable grid of wallet tiles with a search filter.
    Tiles render the wallet's own favicon (`/favicon.svg|ico|png`) and fall back
    to a letter badge. The previous third-party favicon proxy (which 404'd for
    most wallet origins and leaked the wallet URL) is removed.
  - **Custom URL** — pasted wallet URLs are validated against the wallet's
    `/.well-known/enbox-connect` discovery document before the selection
    resolves, with an explicit override when verification is inconclusive.

  New exports for dapps building their own dialog: `probeWalletWellKnown`,
  `WALLET_WELL_KNOWN_PATH`, and the `WalletSelectorOptions` type (which lets
  callers inject a custom validator). The `showWalletSelector(wallets)` call
  signature is unchanged; the options argument is optional.

## 0.3.41

### Patch Changes

- [#1243](https://github.com/enboxorg/enbox/pull/1243) [`3e359b8`](https://github.com/enboxorg/enbox/commit/3e359b863ee0e2ae0a2f6723256f470981211b43) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: update the default browser wallet selector to Enbox, Prism, Matcha, and Onyx

- Updated dependencies [[`a61819a`](https://github.com/enboxorg/enbox/commit/a61819abe3e53751782e50df9a1b26e52e65463f)]:
  - @enbox/agent@0.8.17
  - @enbox/api@0.6.55
  - @enbox/auth@0.6.63

## 0.3.40

### Patch Changes

- [#1237](https://github.com/enboxorg/enbox/pull/1237) [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/agent@0.8.16
  - @enbox/connect@0.1.1
  - @enbox/auth@0.6.62
  - @enbox/api@0.6.54
  - @enbox/dids@0.1.5

## 0.3.39

### Patch Changes

- [#1212](https://github.com/enboxorg/enbox/pull/1212) [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve remaining SonarCloud reliability issues (S7773/S7781/S7758/S6853/S8786)

  Behavior-preserving reliability hardening across packages:

  - Replace global `parseInt`/`isNaN` with `Number.parseInt`/`Number.isNaN` (S7773).
  - Replace `String#replace(/…/g)` and `split().join()` with `String#replaceAll` (S7781).
  - Prefer `String.fromCodePoint`/`String#codePointAt` in byte-range encoders (S7758).
  - Associate admin-UI form labels with their inputs via `for`/`id` (S6853).
  - Strip trailing slashes in the local-node `/info` handler with a linear loop
    instead of a backtracking-prone regex (S8786).

- Updated dependencies [[`378f3d4`](https://github.com/enboxorg/enbox/commit/378f3d4b07a011e9f56852cfc0a4e9da8cd13bd4), [`d7f0a87`](https://github.com/enboxorg/enbox/commit/d7f0a87b211c7eb3fb2ee1e048a51b2deab2305a), [`49449ad`](https://github.com/enboxorg/enbox/commit/49449ade45463baa3ac2190c5455b7dba1f1e39b), [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a), [`c12b323`](https://github.com/enboxorg/enbox/commit/c12b3239ce03bf29bcd2b3a37c8c650c7b29ace1), [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9), [`55581c7`](https://github.com/enboxorg/enbox/commit/55581c71dc1ea7bc8715f92c56ba71692f7bc33e), [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/agent@0.8.15
  - @enbox/auth@0.6.61
  - @enbox/api@0.6.53
  - @enbox/dids@0.1.4

## 0.3.38

### Patch Changes

- Updated dependencies [[`d7467fe`](https://github.com/enboxorg/enbox/commit/d7467fef30d809e25bd0c840338301b9b9d912e0)]:
  - @enbox/agent@0.8.14
  - @enbox/auth@0.6.60
  - @enbox/api@0.6.52

## 0.3.37

### Patch Changes

- Updated dependencies [[`96ea6cb`](https://github.com/enboxorg/enbox/commit/96ea6cbda08a4bb6540d8a4e2664278f82d6fba8), [`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/auth@0.6.59
  - @enbox/api@0.6.51
  - @enbox/agent@0.8.13

## 0.3.36

### Patch Changes

- Updated dependencies [[`60a9abb`](https://github.com/enboxorg/enbox/commit/60a9abb62e3c16368793f17b9ee0e735938ae804), [`0dd7dff`](https://github.com/enboxorg/enbox/commit/0dd7dffff90360b0d0e6d82574b3b9a33a872ab0)]:
  - @enbox/agent@0.8.12
  - @enbox/auth@0.6.58
  - @enbox/api@0.6.50

## 0.3.35

### Patch Changes

- Updated dependencies [[`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979)]:
  - @enbox/agent@0.8.11
  - @enbox/auth@0.6.57
  - @enbox/api@0.6.49

## 0.3.34

### Patch Changes

- Updated dependencies [[`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331), [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff), [`9211810`](https://github.com/enboxorg/enbox/commit/921181002eacc4fdec2264c1334cc7e91b3b0781)]:
  - @enbox/agent@0.8.10
  - @enbox/auth@0.6.56
  - @enbox/api@0.6.48

## 0.3.33

### Patch Changes

- [#1152](https://github.com/enboxorg/enbox/pull/1152) [`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish browser-conditioned entrypoints without Node global shim requirements

- [#1151](https://github.com/enboxorg/enbox/pull/1151) [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: replace delegate response key delivery with sealed audience control records

- Updated dependencies [[`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e), [`78cd3e5`](https://github.com/enboxorg/enbox/commit/78cd3e5b8412b308077f318b58bf5fd3db63d996), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58), [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6), [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c), [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688), [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46)]:
  - @enbox/agent@0.8.9
  - @enbox/api@0.6.47
  - @enbox/auth@0.6.55
  - @enbox/dids@0.1.3

## 0.3.32

### Patch Changes

- Updated dependencies [[`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1), [`d8726ea`](https://github.com/enboxorg/enbox/commit/d8726eae2002fc45e479d850b1fefd1af70bbb80)]:
  - @enbox/agent@0.8.8
  - @enbox/api@0.6.46
  - @enbox/auth@0.6.54

## 0.3.31

### Patch Changes

- [#1077](https://github.com/enboxorg/enbox/pull/1077) [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: implement DWN encryption v1 records, protocol keys, and delegate key delivery

- Updated dependencies [[`2333413`](https://github.com/enboxorg/enbox/commit/23334132ac1b6441e249e4482535df6a049f87d4), [`b96eb50`](https://github.com/enboxorg/enbox/commit/b96eb508d7a9ebd6ec7a7a15fec62e7e26d12a18), [`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7), [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37), [`bae4e73`](https://github.com/enboxorg/enbox/commit/bae4e730197e389f1458aac70f3a8e664432b7c9), [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc)]:
  - @enbox/agent@0.8.7
  - @enbox/auth@0.6.53
  - @enbox/api@0.6.45
  - @enbox/dids@0.1.2

## 0.3.30

### Patch Changes

- Updated dependencies [[`41233ae`](https://github.com/enboxorg/enbox/commit/41233ae542882a1245734d0bdf9435dfab919793)]:
  - @enbox/agent@0.8.6
  - @enbox/api@0.6.44
  - @enbox/auth@0.6.52

## 0.3.29

### Patch Changes

- [#1072](https://github.com/enboxorg/enbox/pull/1072) [`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add bounded, display-only connect session metadata to permission grants and default connect-created grants to a hard 24-hour expiration.

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/agent@0.8.5
  - @enbox/api@0.6.43
  - @enbox/auth@0.6.51

## 0.3.28

### Patch Changes

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/agent@0.8.4
  - @enbox/api@0.6.42
  - @enbox/auth@0.6.50

## 0.3.27

### Patch Changes

- Updated dependencies [[`7ee6ff9`](https://github.com/enboxorg/enbox/commit/7ee6ff98bd01a673aab23f46d69db1b90f8ccd91)]:
  - @enbox/agent@0.8.3
  - @enbox/api@0.6.41
  - @enbox/auth@0.6.49

## 0.3.26

### Patch Changes

- Updated dependencies [[`5a2498f`](https://github.com/enboxorg/enbox/commit/5a2498f49582db6a51e50fd0c78bb3d622460d84), [`4d96b19`](https://github.com/enboxorg/enbox/commit/4d96b19e36be398dde948e783b9240d93ec57aa2), [`7ff772b`](https://github.com/enboxorg/enbox/commit/7ff772bc41965463e571471f54800ce019c0f625)]:
  - @enbox/auth@0.6.48
  - @enbox/agent@0.8.2
  - @enbox/api@0.6.40

## 0.3.25

### Patch Changes

- Updated dependencies [[`7baefc6`](https://github.com/enboxorg/enbox/commit/7baefc69fcae948ce93b9fa4ee69aea050ac2f2b)]:
  - @enbox/auth@0.6.47
  - @enbox/api@0.6.39

## 0.3.24

### Patch Changes

- Updated dependencies [[`12413b1`](https://github.com/enboxorg/enbox/commit/12413b121b5387a1eb03faee4651b3770e1b2f6e), [`db83e50`](https://github.com/enboxorg/enbox/commit/db83e508fbc8e1628ef736c46a590aad6dec432a), [`777bd26`](https://github.com/enboxorg/enbox/commit/777bd26c428c6f1562fed743831f085b683541d5), [`69c6367`](https://github.com/enboxorg/enbox/commit/69c6367a2c597ba858eed0eb28de099ab491199e), [`15817c9`](https://github.com/enboxorg/enbox/commit/15817c96e407175f4c8fb4a56a784bc56aa9959a), [`09f7002`](https://github.com/enboxorg/enbox/commit/09f700217297b8101f4689f5e8a84c8a910f2def), [`8bb1af2`](https://github.com/enboxorg/enbox/commit/8bb1af25e772c730de185a4e4b6fdf5b1aead052), [`0e4f67c`](https://github.com/enboxorg/enbox/commit/0e4f67c0c76c5d56603a5d5115ee7253d90fa0c9), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`228d8dc`](https://github.com/enboxorg/enbox/commit/228d8dcd2d211f7953b86e7e7c4358d9fdb27827), [`79a860d`](https://github.com/enboxorg/enbox/commit/79a860d2a007c4eb9092d46221bda61fbb0e8348), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`4ed695f`](https://github.com/enboxorg/enbox/commit/4ed695f18e4f9b2a4a2a68ca47fb39e4933e35b2), [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87), [`8928c5d`](https://github.com/enboxorg/enbox/commit/8928c5dfb6b5d8e44db016222bdb9acb8941f099), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549), [`49e2a4b`](https://github.com/enboxorg/enbox/commit/49e2a4be2db6692219519674e2b2f2b2db5c9c23), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`97fffdf`](https://github.com/enboxorg/enbox/commit/97fffdfa827995c75497fe22a2a7631fb7c0a22d), [`4129d17`](https://github.com/enboxorg/enbox/commit/4129d1712503ad67010630f729ef37d4ea8fc27b)]:
  - @enbox/agent@0.8.1
  - @enbox/api@0.6.38
  - @enbox/auth@0.6.46

## 0.3.23

### Patch Changes

- Updated dependencies [[`817e816`](https://github.com/enboxorg/enbox/commit/817e8162ed0393402d05ad903a3fd976f84fa8fc)]:
  - @enbox/auth@0.6.45
  - @enbox/api@0.6.37

## 0.3.22

### Patch Changes

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/agent@0.8.0
  - @enbox/api@0.6.36
  - @enbox/auth@0.6.44

## 0.3.21

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.7.10
  - @enbox/api@0.6.35
  - @enbox/auth@0.6.43

## 0.3.20

### Patch Changes

- Updated dependencies [[`4837d72`](https://github.com/enboxorg/enbox/commit/4837d725a96739c2c5fae892018087b238577e8a)]:
  - @enbox/agent@0.7.9
  - @enbox/api@0.6.34
  - @enbox/auth@0.6.42

## 0.3.19

### Patch Changes

- Updated dependencies [[`6aaab40`](https://github.com/enboxorg/enbox/commit/6aaab40bffd77b09d05275f2d786b8091c336188), [`edd4b0f`](https://github.com/enboxorg/enbox/commit/edd4b0f27685de001bcff3cb9ca75410708043b0), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3), [`5bcc5ac`](https://github.com/enboxorg/enbox/commit/5bcc5ac00a2c478c09737e725d6df50d4d017c2f), [`92011b6`](https://github.com/enboxorg/enbox/commit/92011b6938b0e59eabf3b7ee3849f6e5f339c7a3), [`e7946e7`](https://github.com/enboxorg/enbox/commit/e7946e7e7e517be5c1c1b9c643f6e01305252ef9), [`37cac82`](https://github.com/enboxorg/enbox/commit/37cac82c0f3476f1e76eeae22665b1656a4c687e), [`31111b6`](https://github.com/enboxorg/enbox/commit/31111b651716e2a56f68fba93a43891e38c82161), [`6222ba9`](https://github.com/enboxorg/enbox/commit/6222ba9c90552e891cd4797196835544bd437a38), [`485bc75`](https://github.com/enboxorg/enbox/commit/485bc757375824265de3c294a00db9ab826620c8)]:
  - @enbox/agent@0.7.8
  - @enbox/api@0.6.33
  - @enbox/auth@0.6.41

## 0.3.18

### Patch Changes

- [#952](https://github.com/enboxorg/enbox/pull/952) [`540babf`](https://github.com/enboxorg/enbox/commit/540babff775a2943ec9688027b95c1825c29c72b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a dedicated recovery-phrase restore path that preserves existing vault data when the phrase matches, rejects mismatched local vaults without replacing them, and exposes a wallet-friendly `restoreFromPhrase()` API. Remove the deprecated phrase import and local-connect aliases so vault recovery has one public API, while preserving delegate sync-scope repair inside the restore flow.

- Updated dependencies [[`540babf`](https://github.com/enboxorg/enbox/commit/540babff775a2943ec9688027b95c1825c29c72b)]:
  - @enbox/agent@0.7.7
  - @enbox/auth@0.6.40
  - @enbox/api@0.6.32

## 0.3.17

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.7.6
  - @enbox/api@0.6.31
  - @enbox/auth@0.6.39

## 0.3.16

### Patch Changes

- Updated dependencies [[`c1fefdb`](https://github.com/enboxorg/enbox/commit/c1fefdb1f8caec7a421ea4c2465d4d2c96a33f76)]:
  - @enbox/agent@0.7.5
  - @enbox/api@0.6.30
  - @enbox/auth@0.6.38

## 0.3.15

### Patch Changes

- Updated dependencies [[`9a713ce`](https://github.com/enboxorg/enbox/commit/9a713ce549e1dfe07121baa6a2837abb9b0b71a7)]:
  - @enbox/agent@0.7.4
  - @enbox/auth@0.6.37
  - @enbox/api@0.6.29

## 0.3.14

### Patch Changes

- Updated dependencies [[`e58dd0a`](https://github.com/enboxorg/enbox/commit/e58dd0a517fe1fbb6c8e7c862904493b02353293)]:
  - @enbox/agent@0.7.3
  - @enbox/api@0.6.28
  - @enbox/auth@0.6.36

## 0.3.13

### Patch Changes

- Updated dependencies [[`749c657`](https://github.com/enboxorg/enbox/commit/749c657136988b07084d79ae3506e7c4c72c65aa)]:
  - @enbox/auth@0.6.35
  - @enbox/api@0.6.27

## 0.3.12

### Patch Changes

- [#937](https://github.com/enboxorg/enbox/pull/937) [`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Register agent DID for sync in vault connect and import-from-phrase flows to enable seed phrase recovery. Rename `localConnect` to `vaultConnect` and `LocalConnectOptions` to `VaultConnectOptions` (old names preserved as deprecated aliases). Export `IdentityProtocolDefinition` and `JwkProtocolDefinition` from `@enbox/agent`.

- Updated dependencies [[`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27)]:
  - @enbox/agent@0.7.2
  - @enbox/auth@0.6.34
  - @enbox/api@0.6.26

## 0.3.11

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
  - @enbox/agent@0.7.1
  - @enbox/api@0.6.25
  - @enbox/auth@0.6.33

## 0.3.10

### Patch Changes

- Updated dependencies [[`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999)]:
  - @enbox/agent@0.7.0
  - @enbox/api@0.6.24
  - @enbox/auth@0.6.32

## 0.3.9

### Patch Changes

- Updated dependencies [[`55f20c8`](https://github.com/enboxorg/enbox/commit/55f20c83218b97f5091aad8d450bfc32e8958c77)]:
  - @enbox/agent@0.6.8
  - @enbox/api@0.6.23
  - @enbox/auth@0.6.31

## 0.3.8

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.6.7
  - @enbox/api@0.6.22
  - @enbox/auth@0.6.30

## 0.3.7

### Patch Changes

- Updated dependencies [[`1240bb1`](https://github.com/enboxorg/enbox/commit/1240bb167ffedc051f5a1e4beb08463080d18ae0), [`b35f5cb`](https://github.com/enboxorg/enbox/commit/b35f5cb8eb726dd26bcb83b2082d3190a83a36f7), [`149e0b7`](https://github.com/enboxorg/enbox/commit/149e0b79ded21a7f558ecd8e2c5e6268b4d6ba2e)]:
  - @enbox/agent@0.6.6
  - @enbox/api@0.6.21
  - @enbox/auth@0.6.29

## 0.3.6

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.6.5
  - @enbox/api@0.6.20
  - @enbox/auth@0.6.28

## 0.3.5

### Patch Changes

- Updated dependencies [[`b9c667f`](https://github.com/enboxorg/enbox/commit/b9c667f6dc7994b257fefd19ed6db35a19477d98)]:
  - @enbox/auth@0.6.27
  - @enbox/api@0.6.19

## 0.3.4

### Patch Changes

- Updated dependencies [[`7452b53`](https://github.com/enboxorg/enbox/commit/7452b53b7e574a220f5bc98bbc80c8a033bfd5db)]:
  - @enbox/auth@0.6.26
  - @enbox/api@0.6.18

## 0.3.3

### Patch Changes

- Updated dependencies [[`e582ab0`](https://github.com/enboxorg/enbox/commit/e582ab05e6f242ee99e00dc0e94853ee2dcc5e51)]:
  - @enbox/auth@0.6.25
  - @enbox/api@0.6.17

## 0.3.2

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/agent@0.6.4
  - @enbox/api@0.6.16
  - @enbox/auth@0.6.24

## 0.3.1

### Patch Changes

- [#858](https://github.com/enboxorg/enbox/pull/858) [`5535a9d`](https://github.com/enboxorg/enbox/commit/5535a9d538cdbbaca1bdc6e749f6fb710dac4adb) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: export showWalletSelector, fix portableIdentity type to PortableIdentity

  - Export `showWalletSelector` from `@enbox/browser` so apps can use the Shadow DOM wallet picker directly for custom connect flows (e.g. identity export)
  - Fix `DWebConnectClientOptions.portableIdentity` type from `PortableDid` to `PortableIdentity` to match what the wallet's `agent.identity.import()` expects
  - Add integration test for all browser package re-exports

## 0.3.0

### Minor Changes

- [#856](https://github.com/enboxorg/enbox/pull/856) [`8154bb5`](https://github.com/enboxorg/enbox/commit/8154bb509deadf6e2446c39d2ad58e42de8181d7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: re-export api/auth from browser, update wallet defaults, add DWebConnect app metadata

  - Re-export `Enbox`, `defineProtocol`, `repository` from `@enbox/api` and `AuthManager`, `AuthSession`, connect types from `@enbox/auth` so browser dapps need only a single `@enbox/browser` import
  - Update `DEFAULT_WALLETS` to `enbox-wallet.pages.dev` and `blue-enbox-wallet.pages.dev` with description field
  - Add `appName`, `appIcon`, and `portableIdentity` to the DWeb Connect postMessage protocol for richer wallet consent screens and identity export flows
  - Add `description` field to `WalletOption` interface, rendered in the wallet selector modal

## 0.2.1

### Patch Changes

- Updated dependencies [[`57b1b52`](https://github.com/enboxorg/enbox/commit/57b1b52dcf80f2a4e995d649bb64c9e0b9eac9d8)]:
  - @enbox/agent@0.6.3
  - @enbox/auth@0.6.23

## 0.2.0

### Minor Changes

- [#852](https://github.com/enboxorg/enbox/pull/852) [`50c0d7e`](https://github.com/enboxorg/enbox/commit/50c0d7ed368d4a1b0c0c38673875c2f96f26802b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: ECDH-encrypted postMessage channel for DWeb Connect popup flow

  The browser DWeb Connect popup flow now encrypts the authorization response
  (containing delegate private keys and decryption material) using an ephemeral
  ECDH key exchange between the dapp and wallet popup.

  The dapp generates an ephemeral P-256 keypair and sends its public key with
  the authorization request. The wallet generates its own ephemeral keypair,
  performs ECDH + HKDF to derive a shared AES-256-GCM key, encrypts the
  response payload, and sends the ciphertext. The dapp derives the same key
  and decrypts.

  Falls back to plaintext for wallets that don't support encrypted responses
  (backward compatible). Exports encryptPostMessagePayload,
  generateEphemeralKeyPair, and EncryptedPostMessagePayload for use by wallet
  implementations.

### Patch Changes

- Updated dependencies [[`140bd84`](https://github.com/enboxorg/enbox/commit/140bd8474d0a333fe0b5428e1835d8176d269293), [`928f72f`](https://github.com/enboxorg/enbox/commit/928f72fb81beb7a979908e323ebe6510358b31b6)]:
  - @enbox/agent@0.6.2
  - @enbox/auth@0.6.22

## 0.1.26

### Patch Changes

- [#845](https://github.com/enboxorg/enbox/pull/845) [`18b9523`](https://github.com/enboxorg/enbox/commit/18b952381c23199a7ceb0b6dd4be018d7cfb14c5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: browser DWeb Connect client now parses full ConnectResult including delegate encryption artifacts

  The browser popup connect flow was only extracting delegateDid, connectedDid, and
  grants from the wallet's postMessage response — missing delegateDecryptionKeys,
  delegateContextKeys, delegateMultiPartyProtocols, and sessionRevocations. Without
  these, the delegate session had no decryption material, causing encrypted records
  to be unreadable after page refresh and key-delivery protocol closure failures.

## 0.1.25

### Patch Changes

- Updated dependencies [[`d3ae193`](https://github.com/enboxorg/enbox/commit/d3ae193f546443e0a3ceb059cd721aaae2844ae3)]:
  - @enbox/agent@0.6.1
  - @enbox/auth@0.6.21

## 0.1.24

### Patch Changes

- Updated dependencies [[`963d366`](https://github.com/enboxorg/enbox/commit/963d366de71e9e6c077e0ed1ad11904e8a587c92), [`f7b4c79`](https://github.com/enboxorg/enbox/commit/f7b4c79f5a11a4d3de7836bb1ee56e47c90faf3b), [`28fd8ed`](https://github.com/enboxorg/enbox/commit/28fd8ed952df6ea032f246180370169758a1b0f8)]:
  - @enbox/agent@0.6.0
  - @enbox/auth@0.6.20

## 0.1.23

### Patch Changes

- Updated dependencies [[`1c567c0`](https://github.com/enboxorg/enbox/commit/1c567c008e60738e7fbbba5f511cf201c96f183e)]:
  - @enbox/agent@0.5.16
  - @enbox/auth@0.6.19

## 0.1.22

### Patch Changes

- Updated dependencies [[`98eb9be`](https://github.com/enboxorg/enbox/commit/98eb9be0c616da886db5d43e3186874e050d44c2)]:
  - @enbox/agent@0.5.15
  - @enbox/auth@0.6.18

## 0.1.21

### Patch Changes

- Updated dependencies [[`6b77eee`](https://github.com/enboxorg/enbox/commit/6b77eeed4d0ae4b99b14631b41eb7ebaf0dd9587)]:
  - @enbox/agent@0.5.14
  - @enbox/auth@0.6.17

## 0.1.20

### Patch Changes

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/agent@0.5.13
  - @enbox/auth@0.6.16

## 0.1.19

### Patch Changes

- Updated dependencies [[`43d805e`](https://github.com/enboxorg/enbox/commit/43d805e51b63c358f1c9c1a51623d0c5f44446fe)]:
  - @enbox/agent@0.5.12
  - @enbox/auth@0.6.15

## 0.1.18

### Patch Changes

- Updated dependencies [[`5818860`](https://github.com/enboxorg/enbox/commit/5818860e2bca5201ff368d4748393efb1544d7a2)]:
  - @enbox/agent@0.5.11
  - @enbox/auth@0.6.14

## 0.1.17

### Patch Changes

- Updated dependencies [[`3199425`](https://github.com/enboxorg/enbox/commit/319942541442670d8f1fd203adc522781d3cee72)]:
  - @enbox/agent@0.5.10
  - @enbox/auth@0.6.13

## 0.1.16

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/agent@0.5.9
  - @enbox/auth@0.6.12

## 0.1.15

### Patch Changes

- Updated dependencies [[`3ce537a`](https://github.com/enboxorg/enbox/commit/3ce537a4f5e5137b6cedf65af50c33ddbdf6a6a2)]:
  - @enbox/agent@0.5.8
  - @enbox/auth@0.6.11

## 0.1.14

### Patch Changes

- Updated dependencies [[`e269cbf`](https://github.com/enboxorg/enbox/commit/e269cbf58cf7c29fc0e1e7865ecfa7f42ea54122)]:
  - @enbox/auth@0.6.10
  - @enbox/agent@0.5.7

## 0.1.13

### Patch Changes

- Updated dependencies [[`682fb85`](https://github.com/enboxorg/enbox/commit/682fb858343319e3a4da54b08017382596896d6a), [`c8360c3`](https://github.com/enboxorg/enbox/commit/c8360c3856eebec89d717003fe3e0e21a9f182fe)]:
  - @enbox/agent@0.5.6
  - @enbox/auth@0.6.9

## 0.1.12

### Patch Changes

- Updated dependencies [[`3910ebb`](https://github.com/enboxorg/enbox/commit/3910ebb5b25d29161359d7ffa426ac85534f16a6)]:
  - @enbox/auth@0.6.8
  - @enbox/agent@0.5.5

## 0.1.11

### Patch Changes

- Updated dependencies [[`d6b643d`](https://github.com/enboxorg/enbox/commit/d6b643ddab34bf8d82226c368727a3566ae84d48)]:
  - @enbox/agent@0.5.4
  - @enbox/auth@0.6.7

## 0.1.10

### Patch Changes

- Updated dependencies []:
  - @enbox/agent@0.5.3
  - @enbox/auth@0.6.6

## 0.1.9

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/agent@0.5.2
  - @enbox/auth@0.6.5

## 0.1.8

### Patch Changes

- Updated dependencies [[`5f3e33e`](https://github.com/enboxorg/enbox/commit/5f3e33edf3dee9268716c8ac8c049da3abf010e4)]:
  - @enbox/auth@0.6.4

## 0.1.7

### Patch Changes

- Updated dependencies [[`4c7c71e`](https://github.com/enboxorg/enbox/commit/4c7c71efa25a1eee115ef30424bc6c97189aa8f3)]:
  - @enbox/auth@0.6.3

## 0.1.6

### Patch Changes

- Updated dependencies [[`ef5dc9b`](https://github.com/enboxorg/enbox/commit/ef5dc9b28527538205c0e08032017649ba20964d)]:
  - @enbox/auth@0.6.2

## 0.1.5

### Patch Changes

- [#726](https://github.com/enboxorg/enbox/pull/726) [`7b2003e`](https://github.com/enboxorg/enbox/commit/7b2003e46a894a0e12275ea3af1c77e6bc44f279) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(browser): read connectedDid from wallet response in DWeb Connect

  The dapp client was falling back to `delegateDid.uri` (a `did:jwk` with no DWN endpoints) as the `connectedDid` when the wallet didn't explicitly send one. This caused "Failed to dereference `did:jwk:...#dwn`: notFound" errors during identity import after a successful wallet approval.

  Now reads `connectedDid` from the wallet's authorization response, which contains the actual wallet owner's identity DID (e.g., `did:dht:...`).

## 0.1.4

### Patch Changes

- Updated dependencies [[`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7), [`fc923cb`](https://github.com/enboxorg/enbox/commit/fc923cb6a1f6d8e56f616a69d3e61345898d2cf9)]:
  - @enbox/agent@0.5.1
  - @enbox/auth@0.6.1

## 0.1.3

### Patch Changes

- Updated dependencies [[`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531)]:
  - @enbox/dids@0.1.0

## 0.1.2

### Patch Changes

- [#643](https://github.com/enboxorg/enbox/pull/643) [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Update remaining Web5 references in JSDoc, comments, and package metadata to Enbox

  - Replace ~60 stale "Web5" references in JSDoc/comments across agent, api, auth, browser, crypto, and dwn-server packages
  - Update package.json descriptions for @enbox/crypto and @enbox/browser
  - Fix typo in dwn-server http-api.ts ("am enbox" → "an enbox")
  - Update code examples in @enbox/auth to use `Enbox.connect()` instead of `new Web5()`

- Updated dependencies []:
  - @enbox/dids@0.0.9

## 0.1.1

### Patch Changes

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/dids@0.0.8

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

## 0.0.6

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/dids@0.0.6

## 0.0.5

### Patch Changes

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/dids@0.0.5

## 0.0.4

### Patch Changes

- Updated dependencies []:
  - @enbox/dids@0.0.4

## 0.0.3

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/dids@0.0.3

This package is a fork of the official Web5 Browser package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/web5-js](https://github.com/decentralized-identity/web5-js)

All changes, releases, and updates are tracked in the upstream repository's changelog.
