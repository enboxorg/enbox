# @enbox/auth

## 0.6.79

### Patch Changes

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

- Updated dependencies [[`ca04167`](https://github.com/enboxorg/enbox/commit/ca04167e6e6e61eea56eedd5eb7acbc3b909fd4c), [`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774), [`f804103`](https://github.com/enboxorg/enbox/commit/f80410366f4e3798018618f2f15ed014fd3796e8), [`23d84a4`](https://github.com/enboxorg/enbox/commit/23d84a4cd94d169423d9fbe5c84b5e7bd803b134), [`2c78d33`](https://github.com/enboxorg/enbox/commit/2c78d3371c3cb26fea33245866326b9e43df528e), [`e07585c`](https://github.com/enboxorg/enbox/commit/e07585ce0e7ffcb65a32c51e1da22d48588339e0), [`fe5f985`](https://github.com/enboxorg/enbox/commit/fe5f9859438ce1e9663cfc7bda1b5c6eb82b7774), [`50c40fd`](https://github.com/enboxorg/enbox/commit/50c40fd50950d5a25c0d5c342f55b078adf247e9), [`7a6abfd`](https://github.com/enboxorg/enbox/commit/7a6abfd92ca2cb019f5a7aa5260d12d06c59ce8d), [`713c757`](https://github.com/enboxorg/enbox/commit/713c7577c2ece2f59929f5f226abdf6cf40a7e1c)]:
  - @enbox/common@0.1.5
  - @enbox/dwn-sdk-js@0.4.17
  - @enbox/agent@0.8.33
  - @enbox/connect@0.1.13
  - @enbox/crypto@0.1.8
  - @enbox/dids@0.1.8
  - @enbox/dwn-clients@0.4.24

## 0.6.78

### Patch Changes

- Updated dependencies [[`4043f46`](https://github.com/enboxorg/enbox/commit/4043f46136cf23f08eb092976f1cb12cbb600ca7), [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2), [`61ceb57`](https://github.com/enboxorg/enbox/commit/61ceb575144c0eea39cee6938ce2f2c474c8b6f2), [`64115f8`](https://github.com/enboxorg/enbox/commit/64115f8d9fbfb37bf16cb04603556a0873de6b53), [`4426e72`](https://github.com/enboxorg/enbox/commit/4426e72a213fffbf420ce776fb2adb31c9c4f9b3), [`82e2f62`](https://github.com/enboxorg/enbox/commit/82e2f628fd6441eb4ca81be0b13952d11fbe6cba), [`a0aa94e`](https://github.com/enboxorg/enbox/commit/a0aa94e727320063dbb806aab57979abbbfb82b1), [`c603c33`](https://github.com/enboxorg/enbox/commit/c603c333387644b2d250cc4e778be1ebb14581ff), [`bd3ea12`](https://github.com/enboxorg/enbox/commit/bd3ea128fdad3c28e2291028b054640ecfc159e2), [`87afa05`](https://github.com/enboxorg/enbox/commit/87afa055a2aa23e7981f83dbff1ff2add138ea94), [`4062e4a`](https://github.com/enboxorg/enbox/commit/4062e4ab7e588c11a7f2fcfe302ac5cf048e4624), [`686c918`](https://github.com/enboxorg/enbox/commit/686c918e33d11af23314a2be421d3b66028020a1), [`7a437b2`](https://github.com/enboxorg/enbox/commit/7a437b2bed8cdb88b30eec86fb6420801845a352), [`06793a4`](https://github.com/enboxorg/enbox/commit/06793a4ddb8577b6f73c59db001e89fa2499f18c)]:
  - @enbox/agent@0.8.32
  - @enbox/dwn-clients@0.4.23
  - @enbox/dwn-sdk-js@0.4.16
  - @enbox/connect@0.1.12

## 0.6.77

### Patch Changes

- Updated dependencies [[`bad337e`](https://github.com/enboxorg/enbox/commit/bad337e27a7f5e1029780401a419bc5c313c03ff), [`7267cf1`](https://github.com/enboxorg/enbox/commit/7267cf1e406484d3361d926368a97e2b0353a9a3), [`6688e32`](https://github.com/enboxorg/enbox/commit/6688e327e27d52a55d6daabdcfe1195f2954a67a)]:
  - @enbox/agent@0.8.31
  - @enbox/dwn-sdk-js@0.4.15
  - @enbox/connect@0.1.11
  - @enbox/dwn-clients@0.4.22

## 0.6.76

### Patch Changes

- [#1373](https://github.com/enboxorg/enbox/pull/1373) [`da812fc`](https://github.com/enboxorg/enbox/commit/da812fcfd501f4135682683f2960793c0ad37d26) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: the sync engine is live-only — poll mode removed. startSync starts live sync; `interval` now sets the periodic settle-check cadence. Userland polling remains trivial via the public one-shot sync(): setInterval(() => { agent.sync.sync().catch(console.error); }, ms).

- Updated dependencies [[`257fa11`](https://github.com/enboxorg/enbox/commit/257fa11e014b59a758e93dcdeb8dec9b6deb989b), [`da812fc`](https://github.com/enboxorg/enbox/commit/da812fcfd501f4135682683f2960793c0ad37d26), [`83020bd`](https://github.com/enboxorg/enbox/commit/83020bdcf86e4db86f00f877c88427fc7e36f7bc), [`8b9ab70`](https://github.com/enboxorg/enbox/commit/8b9ab7017d5ac9d37920249c54d75264cad1fe99), [`3804b5d`](https://github.com/enboxorg/enbox/commit/3804b5dc1ddb94cd7beaff7045345efd474f6965), [`b334497`](https://github.com/enboxorg/enbox/commit/b33449751d36dd5c3bfddce7d208c75a9418bf50), [`08c6912`](https://github.com/enboxorg/enbox/commit/08c69121ecdfcfe2adc7758e7242d28b894caa95)]:
  - @enbox/agent@0.8.30

## 0.6.75

### Patch Changes

- Updated dependencies [[`9dd09a6`](https://github.com/enboxorg/enbox/commit/9dd09a6d76a98eb54da813b1a3dc9b648527f7f3), [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca), [`535922a`](https://github.com/enboxorg/enbox/commit/535922a5c7c4312bac6155cfa34cff38bf458080)]:
  - @enbox/agent@0.8.29
  - @enbox/dwn-clients@0.4.21
  - @enbox/dwn-sdk-js@0.4.14
  - @enbox/connect@0.1.10

## 0.6.74

### Patch Changes

- [#1313](https://github.com/enboxorg/enbox/pull/1313) [`8d59d0b`](https://github.com/enboxorg/enbox/commit/8d59d0b39e7d0cfefdb4a416da669aa77a69cda7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: preserve stateful provider-auth callback behavior during DWN registration

- [#1355](https://github.com/enboxorg/enbox/pull/1355) [`cd6940e`](https://github.com/enboxorg/enbox/commit/cd6940e28434cac31587bd2745ce3411d670bfa3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add a framework-agnostic connection store and a typed connect-denied error

  - `@enbox/auth`: connect, refresh, and wallet-connect denials now throw a typed `ConnectDeniedError` (messages unchanged); branch on the new `isConnectDeniedError()` predicate instead of string-matching error messages.
  - `@enbox/api`: new `createConnectionStore()` — a headless, subscribable store that composes `AuthManager` + `Enbox` into one observable state machine (`initializing | disconnected | connecting | connected | error`), with `getSnapshot()`/`subscribe()` for `useSyncExternalStore`-style bindings, in-flight guards, delegated connection monitoring, and `dispose()` teardown.
  - `@enbox/browser`: re-exports `createConnectionStore`, its types, `ConnectDeniedError`, and `isConnectDeniedError`.

- [#1308](https://github.com/enboxorg/enbox/pull/1308) [`9889d7d`](https://github.com/enboxorg/enbox/commit/9889d7dcaf9fb53d2da7efea08b8d3c3f173932e) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity in connect/session functions (Sonar S3776)

  Behavior-preserving extract-method refactoring of 7 auth functions flagged for
  excessive cognitive complexity (CC 17–34), bringing each to the ≤15 threshold. Each
  extraction lifts a contiguous logical unit (a validation pass, a branch handler, a
  retry/fallback block) into a named helper called at the exact same point; no
  validation/auth/security check was reordered, weakened, or removed, and no error
  type/message changed.

  - `AuthManager._pollConnectionMonitor` — status-handling and error-handling extracted.
  - `connect/lifecycle.ts` `registerSyncScopeForIdentity` / `processDelegateGrantsForExistingIdentity`
    — the shared "register-or-fallback-to-update" and "unregister-tolerating-not-registered"
    blocks factored into helpers (identical error-message checks preserved).
  - `connect/status.ts` `computeConnectionStatus` — timestamp resolution, grant grouping,
    newest-group selection, and status derivation extracted.
  - `connect/restore.ts` `restoreSession` / `retryOrphanedRevocations` — password resolution,
    retry maintenance, identity resolution, and revocation bookkeeping extracted.
  - `registration.ts` `registerWithDwnEndpoints` — token loading, per-endpoint dispatch,
    provider-auth resolution/refresh, and token persistence extracted (CSRF check and the
    nested provider-auth conditionals preserved without inversion).

  The worst offender — `auth-manager.ts` `_getConnectionMonitorStatus` (CC 143) — is
  intentionally deferred to a dedicated follow-up.

  Verified: `@enbox/auth` build + lint clean; all 570 auth tests pass.

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

- [#1331](https://github.com/enboxorg/enbox/pull/1331) [`d6f72b4`](https://github.com/enboxorg/enbox/commit/d6f72b4ec9f50fd86f288021416c7f22a61c60ed) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: resolve open SonarCloud reliability findings (medium impact)

  - `@enbox/dwn-server-admin-ui`: add an explicit `type="button"` to every
    standalone action `<button>` (none are inside a `<form>`), so clicking them
    can never trigger an implicit form submission (Sonar S9011).
  - `@enbox/auth`: replace the regex-based `<code><separator><detail>` parser in
    `connect/status.ts` with an equivalent hand-written scan. The previous regex
    nested a quantified group inside an optional alternative
    (`\s+(?:[:-]\s*)?`), which Sonar's static analysis flags as capable of
    super-linear backtracking (S8786) even though empirical testing showed no
    actual quadratic blowup. The replacement is provably linear and was verified
    byte-for-byte equivalent to the old regex across 200k fuzzed inputs.

  Also fixes the same button-type issue in two `apps/docs` components
  (non-published, no changeset needed for `@enbox/docs`).

- [#1302](https://github.com/enboxorg/enbox/pull/1302) [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve Sonar reliability findings

  - **dwn-sdk-js** (S7746): drop the redundant `Promise.resolve()` wrapper in the async `Secp256r1.sign()`.
  - **auth** (S8786): rewrite the `normalizeErrorText` status-prefix regex with first-character-disjoint separator alternation, eliminating super-linear backtracking. Behavior-preserving (verified equivalent across 36 inputs).
  - **browser** (S2310, S1994): remove loop-counter mutations in the QR encoder — derive the shifted timing column instead of reassigning the counter, and use a `while` + toggle for pad-byte generation. Output is module-for-module identical to the reference encoder.

- [#1336](https://github.com/enboxorg/enbox/pull/1336) [`c7d1b82`](https://github.com/enboxorg/enbox/commit/c7d1b8265a73134cd55a6330b29d1ede137302c4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat(agent): per-delivery sync events, scoped one-shot sync, coalesced concurrency, and per-link replication status; feat(auth): explicit sync mode option

  Sync engine (`@enbox/agent`):

  - New `delivery:applied` sync event, emitted once per **freshly** applied message a live-pull delivery admits — the delivered root AND any fetched dependency (parent, role record, initial write) the closure admitted alongside it — each with a routing descriptor (`interface`, `method`, `protocol`, `protocolPath`, `recordId`, `contextId`, `author`, `messageTimestamp`) so apps can invalidate exactly the affected state without re-querying. Echoes of messages the store already held (`Duplicate`/`Superseded` applies) do not emit — `admitClosure` now reports `freshEntries` (message + CID) alongside `appliedCids`.
  - `sync(direction?, options?)` accepts `options.did` to scope a one-shot run to a single registered identity's replication targets (an app-triggered "pull my inbox now" no longer re-reconciles every identity). An unregistered DID rejects.
  - Concurrent `sync()` calls now coalesce into one queued follow-up run instead of throwing `Sync operation is already in progress` — joined requests merge (differing directions widen to both, differing scopes widen to unscoped) and share the follow-up's outcome. A runtime transition (`stopSync`/`clear`/`close`/mode switch) while the follow-up is still queued cancels it, rejecting joiners with the new exported `SyncRunCancelledError` — a resolved `sync()` always means a run covering the request completed.
  - New `getReplicationLinks(tenantDid?)` returns read-only per-link snapshots (scope, status, connectivity, checkpoint positions, last activity). All links `'live'` is the per-identity caught-up signal for hot-added identities; `startSync()` resolving covers identities registered before start (now documented).
  - End-to-end regression coverage for the peer-authored inbox pattern: an `anyone`-create record written by a foreign author into the tenant's remote DWN is delivered through live sync in real time, wakes local `MessagesSubscribe` subscribers, and emits `delivery:applied` — including for identities hot-added after `startSync()`.

  Auth (`@enbox/auth`):

  - `SyncOption` now accepts `'live'` and `{ mode: 'live' | 'poll', interval? }` in addition to `'off'`. The bare interval string form (which silently selects poll mode and gives up real-time delivery) is deprecated and logs a one-time warning; behaviour is otherwise unchanged.

- Updated dependencies [[`c4ee0bc`](https://github.com/enboxorg/enbox/commit/c4ee0bc057fb5b2278926fe1d9d1add618acc08d), [`6ad8f08`](https://github.com/enboxorg/enbox/commit/6ad8f08b2b87a9915ddbc6b289284a2b6635fbbd), [`16c8ea4`](https://github.com/enboxorg/enbox/commit/16c8ea46380d303fb20eeec7047b5f1f286f661f), [`3e6d5fe`](https://github.com/enboxorg/enbox/commit/3e6d5fe51f3ae16db0c08174132bcdc828f15c93), [`e83cb4b`](https://github.com/enboxorg/enbox/commit/e83cb4b05e7f184e515ccd547f5ac1c346fea045), [`f41a755`](https://github.com/enboxorg/enbox/commit/f41a755adfe769ad1ca5b00b7275059f2ed2305e), [`73a76e1`](https://github.com/enboxorg/enbox/commit/73a76e1099ebfb6b8e399431541a43d14d3df5ec), [`8f6cc7d`](https://github.com/enboxorg/enbox/commit/8f6cc7de740771a15a7eb1732d0597b2082fb347), [`d5c8e83`](https://github.com/enboxorg/enbox/commit/d5c8e8300ffb30ba89580ea0a37c3f9513470572), [`3309d87`](https://github.com/enboxorg/enbox/commit/3309d87efdea35ca784917b3b0ec05362a4a7c81), [`7f4c4e7`](https://github.com/enboxorg/enbox/commit/7f4c4e7b485f47b8cf0d6c40d60054363f4c56e3), [`a40eb11`](https://github.com/enboxorg/enbox/commit/a40eb11831bd9e669ed1a6b5dca58274be82d9de), [`e33cf82`](https://github.com/enboxorg/enbox/commit/e33cf820fec511d09676f5ea5473fa6db8727c5f), [`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441), [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`757cff1`](https://github.com/enboxorg/enbox/commit/757cff17cbb8bec36f806eec1a8ee3606f3c9ae2), [`2b50952`](https://github.com/enboxorg/enbox/commit/2b5095252fc621d6ea35db5a330759009c2a88e2), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c), [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67), [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`4c32046`](https://github.com/enboxorg/enbox/commit/4c320469d38f4f67c51ad6b82edca397fc0bd4c2), [`4498e5a`](https://github.com/enboxorg/enbox/commit/4498e5ad249bb38e24047d1665b6a19849f5c8a9), [`132cd4a`](https://github.com/enboxorg/enbox/commit/132cd4ad25c428991e60ea52f2871457169e9072), [`48fde39`](https://github.com/enboxorg/enbox/commit/48fde39d5857f8b7bb70ddbfc857ad276e49d27c), [`74dd445`](https://github.com/enboxorg/enbox/commit/74dd445b283e476eb3c26d6fbd3f193c32fa924e), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0), [`76be6bb`](https://github.com/enboxorg/enbox/commit/76be6bba0e0f7a3ae25ee1829915974581960982), [`9e4be6d`](https://github.com/enboxorg/enbox/commit/9e4be6de0206e0c3e2cbd5e235405cffef75e1bc), [`b964d48`](https://github.com/enboxorg/enbox/commit/b964d48ab993934337c348f6655e9923bfa409f3), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`c7d1b82`](https://github.com/enboxorg/enbox/commit/c7d1b8265a73134cd55a6330b29d1ede137302c4), [`d564725`](https://github.com/enboxorg/enbox/commit/d564725121d6488eea74790cb5279b505ff09dc9), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`d275b31`](https://github.com/enboxorg/enbox/commit/d275b31fb738a8f2aa2744dd14a4090481d2c9f4), [`418030a`](https://github.com/enboxorg/enbox/commit/418030a14cd84a889a57aefe0237e5a2f2c39395), [`5b4e0d3`](https://github.com/enboxorg/enbox/commit/5b4e0d305ab9c142111ba8ec553a4d4bd18a8ff7), [`dd311d4`](https://github.com/enboxorg/enbox/commit/dd311d4459a8da2b1c6e0b233c10a5fa299e6548), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`024cd55`](https://github.com/enboxorg/enbox/commit/024cd5592e5cecfbdea348747deb34da9ba21b94), [`b5f49ac`](https://github.com/enboxorg/enbox/commit/b5f49ace4e6ab9e1caf23afb2cdd8735d44985b3)]:
  - @enbox/agent@0.8.28
  - @enbox/dwn-sdk-js@0.4.13
  - @enbox/dwn-clients@0.4.20
  - @enbox/crypto@0.1.7
  - @enbox/dids@0.1.7
  - @enbox/connect@0.1.9
  - @enbox/common@0.1.4

## 0.6.73

### Patch Changes

- Updated dependencies [[`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131)]:
  - @enbox/agent@0.8.27
  - @enbox/dwn-clients@0.4.19

## 0.6.72

### Patch Changes

- Updated dependencies [[`f18cece`](https://github.com/enboxorg/enbox/commit/f18ceceeae21b85aa9898decffe479f6fb729bff)]:
  - @enbox/connect@0.1.8
  - @enbox/agent@0.8.26

## 0.6.71

### Patch Changes

- Updated dependencies [[`0a5cc42`](https://github.com/enboxorg/enbox/commit/0a5cc42c1d8920e6ba9326d6331b3b119c9e7892)]:
  - @enbox/connect@0.1.7
  - @enbox/agent@0.8.25

## 0.6.70

### Patch Changes

- [#1274](https://github.com/enboxorg/enbox/pull/1274) [`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83) Thanks [@poindex-bot](https://github.com/poindex-bot)! - Add delegated connect-session status, expiry error helpers, opt-in monitoring, and same-delegate grant refresh across the auth and browser APIs. Refresh requests now carry an explicit wallet UI signal, reuse the existing delegate keys on popup and relay transports, and select fresh active grants over expired or superseded grants. Connect results now fail closed when grants come from the wrong owner, exceed the requested scope, or contain no usable requested grant.

- Updated dependencies [[`949fa2d`](https://github.com/enboxorg/enbox/commit/949fa2d1fa01e6aea41862b77cee64b42ca73c83)]:
  - @enbox/agent@0.8.24
  - @enbox/connect@0.1.6

## 0.6.69

### Patch Changes

- Updated dependencies [[`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081)]:
  - @enbox/crypto@0.1.6
  - @enbox/agent@0.8.23
  - @enbox/connect@0.1.5
  - @enbox/dids@0.1.6
  - @enbox/dwn-clients@0.4.18
  - @enbox/dwn-sdk-js@0.4.12

## 0.6.68

### Patch Changes

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11
  - @enbox/agent@0.8.22
  - @enbox/connect@0.1.4
  - @enbox/dwn-clients@0.4.17

## 0.6.67

### Patch Changes

- Updated dependencies [[`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919)]:
  - @enbox/connect@0.1.3
  - @enbox/agent@0.8.21

## 0.6.66

### Patch Changes

- Updated dependencies [[`672a13f`](https://github.com/enboxorg/enbox/commit/672a13fd33dde00afdf8fd4fe2de649f06a1b93f)]:
  - @enbox/agent@0.8.20

## 0.6.65

### Patch Changes

- Updated dependencies [[`7e5f7ec`](https://github.com/enboxorg/enbox/commit/7e5f7ec504c8c4f552348c6a091fad389a408a45)]:
  - @enbox/connect@0.1.2
  - @enbox/agent@0.8.19

## 0.6.64

### Patch Changes

- Updated dependencies [[`95ff115`](https://github.com/enboxorg/enbox/commit/95ff11501400dbd0786f14e769d50b833a8a871d)]:
  - @enbox/agent@0.8.18

## 0.6.63

### Patch Changes

- Updated dependencies [[`a61819a`](https://github.com/enboxorg/enbox/commit/a61819abe3e53751782e50df9a1b26e52e65463f)]:
  - @enbox/agent@0.8.17

## 0.6.62

### Patch Changes

- [#1237](https://github.com/enboxorg/enbox/pull/1237) [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/agent@0.8.16
  - @enbox/connect@0.1.1
  - @enbox/dwn-sdk-js@0.4.10
  - @enbox/dwn-clients@0.4.16
  - @enbox/dids@0.1.5

## 0.6.61

### Patch Changes

- [#1228](https://github.com/enboxorg/enbox/pull/1228) [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Harden local-node ejection with authenticated stable drains, safe outage fallback, persisted consent, native token discovery, and durable local storage.

- [#1217](https://github.com/enboxorg/enbox/pull/1217) [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add browser local-node probing, pairing persistence, and token-authenticated DWN transports

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

- Updated dependencies [[`378f3d4`](https://github.com/enboxorg/enbox/commit/378f3d4b07a011e9f56852cfc0a4e9da8cd13bd4), [`d7f0a87`](https://github.com/enboxorg/enbox/commit/d7f0a87b211c7eb3fb2ee1e048a51b2deab2305a), [`49449ad`](https://github.com/enboxorg/enbox/commit/49449ade45463baa3ac2190c5455b7dba1f1e39b), [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a), [`c12b323`](https://github.com/enboxorg/enbox/commit/c12b3239ce03bf29bcd2b3a37c8c650c7b29ace1), [`98f4348`](https://github.com/enboxorg/enbox/commit/98f4348bfbfb7d5ddbc91787f4187958998ba011), [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9), [`55581c7`](https://github.com/enboxorg/enbox/commit/55581c71dc1ea7bc8715f92c56ba71692f7bc33e), [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/agent@0.8.15
  - @enbox/dwn-clients@0.4.15
  - @enbox/common@0.1.3
  - @enbox/dids@0.1.4
  - @enbox/dwn-sdk-js@0.4.9
  - @enbox/crypto@0.1.4

## 0.6.60

### Patch Changes

- [#1202](https://github.com/enboxorg/enbox/pull/1202) [`d7467fe`](https://github.com/enboxorg/enbox/commit/d7467fef30d809e25bd0c840338301b9b9d912e0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: carry the wallet connect request pointer and encryption key in the URI fragment

  `EnboxConnectProtocol` now exposes `buildWalletConnectUri` and `parseWalletConnectUri`, which place the relay `request_uri` and the single-use `encryption_key` in the URI **fragment** rather than the query string. The fragment never leaves the local channel (it is not sent to the wallet's web server on the deep-link path), so the single-use symmetric key protecting the pushed request cannot surface in server or CDN logs. `WalletConnect.initClient` builds the wallet URI through the new helper; consumers that read connect parameters from a wallet URI should parse them with `parseWalletConnectUri`.

- Updated dependencies [[`d7467fe`](https://github.com/enboxorg/enbox/commit/d7467fef30d809e25bd0c840338301b9b9d912e0)]:
  - @enbox/agent@0.8.14

## 0.6.59

### Patch Changes

- [#1187](https://github.com/enboxorg/enbox/pull/1187) [`96ea6cb`](https://github.com/enboxorg/enbox/commit/96ea6cbda08a4bb6540d8a4e2664278f82d6fba8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: restore the active identity (not a stale delegate), remove revoked delegates on disconnect, and surface authorization failures in delegate protocol ensure

  restoreSession preferred any connected identity over the persisted active marker, so a leftover delegate from a disconnected session (grants revoked) shadowed the current one and every call failed with 401. Disconnect now also removes the dead delegate identity locally after clean revocation (kept while revocations are queued for retry), and TypedEnbox reports the query status when the wallet's protocol definition cannot be fetched instead of misreporting a revoked grant as a missing protocol.

- Updated dependencies [[`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/agent@0.8.13
  - @enbox/dwn-sdk-js@0.4.8
  - @enbox/dwn-clients@0.4.14

## 0.6.58

### Patch Changes

- [#1185](https://github.com/enboxorg/enbox/pull/1185) [`60a9abb`](https://github.com/enboxorg/enbox/commit/60a9abb62e3c16368793f17b9ee0e735938ae804) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: stop sync before revoking session grants and park links on revoked/expired authorization

  Disconnect revoked delegated grants while live sync still ran under them, so the engine treated the self-inflicted 401s as repairable failures — error stacks and pointless retries on every successful delegate disconnect. AuthManager.disconnect() now stops sync first (revocation delivery is direct RPC and unaffected), and SyncEngineLevel classifies GrantAuthorizationGrantRevoked/GrantAuthorizationGrantExpired/MessagesSubscribeDeliveryAuthorizationFailed as terminal: the link parks (paused) with one concise log line instead of repair-retrying, which also quiets wallet-initiated revocation while a tool is running.

- [#1183](https://github.com/enboxorg/enbox/pull/1183) [`0dd7dff`](https://github.com/enboxorg/enbox/commit/0dd7dffff90360b0d0e6d82574b3b9a33a872ab0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: validate connect grants (grantee, scope subset) in the shared connect path for every transport

  The grantee-matches-delegate and granted-scopes-subset checks lived in the CLI handler only, so browser popup and direct relay connects imported whatever a wallet returned. The validation now runs in AuthManager's handler flow and in walletConnect, and @enbox/cli drops its private copy.

- Updated dependencies [[`60a9abb`](https://github.com/enboxorg/enbox/commit/60a9abb62e3c16368793f17b9ee0e735938ae804)]:
  - @enbox/agent@0.8.12

## 0.6.57

### Patch Changes

- [#1180](https://github.com/enboxorg/enbox/pull/1180) [`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: release sockets and store handles on shutdown so CLI processes exit

  WebSocket RPC connections are pooled process-wide with heartbeat timers and were never closed, keeping the event loop alive after AuthManager.shutdown() resolved; the agent's DWN stores, DID resolver cache, and vault/secret stores also stayed open, wedging same-dataPath reopens and cross-process writes. Adds WebSocketDwnRpcClient.closeAllConnections() and a close() contract to EnboxRpc, a full EnboxUserAgent.shutdown() lifecycle, and delegates AuthManager.shutdown() to it.

- Updated dependencies [[`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979)]:
  - @enbox/dwn-clients@0.4.13
  - @enbox/agent@0.8.11

## 0.6.56

### Patch Changes

- [#1159](https://github.com/enboxorg/enbox/pull/1159) [`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add a CLI relay connect handler package

- [#1173](https://github.com/enboxorg/enbox/pull/1173) [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add pre-supplied delegate DID support to relay connect flows so CLI clients can keep delegate private keys local while wallets grant to the requested DID.

- Updated dependencies [[`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331), [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff), [`9211810`](https://github.com/enboxorg/enbox/commit/921181002eacc4fdec2264c1334cc7e91b3b0781)]:
  - @enbox/agent@0.8.10

## 0.6.55

### Patch Changes

- [#1152](https://github.com/enboxorg/enbox/pull/1152) [`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish browser-conditioned entrypoints without Node global shim requirements

- [#1151](https://github.com/enboxorg/enbox/pull/1151) [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: replace delegate response key delivery with sealed audience control records

- Updated dependencies [[`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251), [`7ddb0d6`](https://github.com/enboxorg/enbox/commit/7ddb0d677065483968ef9d80773e3fd81048f4ad), [`37895ff`](https://github.com/enboxorg/enbox/commit/37895ff511258ed48d10660b1f73ce597e818921), [`cda1d31`](https://github.com/enboxorg/enbox/commit/cda1d31b4c8a7df444beadd0271ff50a3482fa00), [`5de6973`](https://github.com/enboxorg/enbox/commit/5de6973f98216a3732800a6ec461520b47171902), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`042879e`](https://github.com/enboxorg/enbox/commit/042879ea1e05d45b99ab35e23f1ab2f730afa757), [`efa5171`](https://github.com/enboxorg/enbox/commit/efa5171b36aa0f46e957e74506323f9cbd4d8dc7), [`97dced6`](https://github.com/enboxorg/enbox/commit/97dced6b0eb80fccbd71ea5a8a1c250ba40153bb), [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e), [`78cd3e5`](https://github.com/enboxorg/enbox/commit/78cd3e5b8412b308077f318b58bf5fd3db63d996), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`23ae738`](https://github.com/enboxorg/enbox/commit/23ae7389a4c14aedf360c5b3b3bbdd8c274ef53a), [`b38dd5e`](https://github.com/enboxorg/enbox/commit/b38dd5ec24129a37e8e2bb17b3173144ac9bb863), [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`96bc5f5`](https://github.com/enboxorg/enbox/commit/96bc5f5c2d80f0cb543042e3f41f5c2d4156c3d3), [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6), [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c), [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688), [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852), [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46), [`57c66a3`](https://github.com/enboxorg/enbox/commit/57c66a34079625793c8b26028f29d1eb63b969ef)]:
  - @enbox/agent@0.8.9
  - @enbox/dids@0.1.3
  - @enbox/dwn-sdk-js@0.4.7
  - @enbox/common@0.1.2
  - @enbox/crypto@0.1.3
  - @enbox/dwn-clients@0.4.12

## 0.6.54

### Patch Changes

- Updated dependencies [[`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1), [`d8726ea`](https://github.com/enboxorg/enbox/commit/d8726eae2002fc45e479d850b1fefd1af70bbb80)]:
  - @enbox/dwn-sdk-js@0.4.6
  - @enbox/agent@0.8.8
  - @enbox/dwn-clients@0.4.11

## 0.6.53

### Patch Changes

- [#1077](https://github.com/enboxorg/enbox/pull/1077) [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: implement DWN encryption v1 records, protocol keys, and delegate key delivery

- Updated dependencies [[`2333413`](https://github.com/enboxorg/enbox/commit/23334132ac1b6441e249e4482535df6a049f87d4), [`b96eb50`](https://github.com/enboxorg/enbox/commit/b96eb508d7a9ebd6ec7a7a15fec62e7e26d12a18), [`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7), [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37), [`bae4e73`](https://github.com/enboxorg/enbox/commit/bae4e730197e389f1458aac70f3a8e664432b7c9), [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc)]:
  - @enbox/agent@0.8.7
  - @enbox/dwn-sdk-js@0.4.5
  - @enbox/crypto@0.1.2
  - @enbox/dwn-clients@0.4.10
  - @enbox/dids@0.1.2

## 0.6.52

### Patch Changes

- Updated dependencies [[`41233ae`](https://github.com/enboxorg/enbox/commit/41233ae542882a1245734d0bdf9435dfab919793)]:
  - @enbox/agent@0.8.6

## 0.6.51

### Patch Changes

- [#1072](https://github.com/enboxorg/enbox/pull/1072) [`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add bounded, display-only connect session metadata to permission grants and default connect-created grants to a hard 24-hour expiration.

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/dwn-sdk-js@0.4.4
  - @enbox/agent@0.8.5
  - @enbox/dwn-clients@0.4.9

## 0.6.50

### Patch Changes

- [#1070](https://github.com/enboxorg/enbox/pull/1070) [`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Use `Records.Read` as the canonical read-like records permission for read, query, subscribe, and count operations. Connect requests now emit only read/write/delete record permissions, reject obsolete record query/subscribe/count grant scopes, and keep protocol configuration wallet-owned instead of delegating `Protocols.Configure` to apps. Delegate `TypedEnbox` auto-configuration imports the wallet's signed protocol configuration locally instead of requiring a delegated configure grant.

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/dwn-sdk-js@0.4.3
  - @enbox/agent@0.8.4
  - @enbox/dwn-clients@0.4.8

## 0.6.49

### Patch Changes

- Updated dependencies [[`7ee6ff9`](https://github.com/enboxorg/enbox/commit/7ee6ff98bd01a673aab23f46d69db1b90f8ccd91)]:
  - @enbox/agent@0.8.3

## 0.6.48

### Patch Changes

- [#1053](https://github.com/enboxorg/enbox/pull/1053) [`5a2498f`](https://github.com/enboxorg/enbox/commit/5a2498f49582db6a51e50fd0c78bb3d622460d84) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: surface recovered identity sync registration failures

- Updated dependencies [[`05f5621`](https://github.com/enboxorg/enbox/commit/05f56216adcbdba09ae039238055a4591674ef88), [`4d96b19`](https://github.com/enboxorg/enbox/commit/4d96b19e36be398dde948e783b9240d93ec57aa2)]:
  - @enbox/dwn-sdk-js@0.4.2
  - @enbox/agent@0.8.2
  - @enbox/dwn-clients@0.4.7

## 0.6.47

### Patch Changes

- [#1051](https://github.com/enboxorg/enbox/pull/1051) [`7baefc6`](https://github.com/enboxorg/enbox/commit/7baefc69fcae948ce93b9fa4ee69aea050ac2f2b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: preserve and repair agent DID recovery sync scope

## 0.6.46

### Patch Changes

- [#1043](https://github.com/enboxorg/enbox/pull/1043) [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Require nested protocol Query, Count, and Subscribe filters to pin the direct parent contextId, make permission revocation filtering opt-in with scalar per-grant checks, and route delegated sync scope derivation through the permissions API.

- [#1035](https://github.com/enboxorg/enbox/pull/1035) [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove legacy sync index, wire, and sparse-tree surfaces now that replication uses durable message feeds and scoped fingerprints.

- Updated dependencies [[`12413b1`](https://github.com/enboxorg/enbox/commit/12413b121b5387a1eb03faee4651b3770e1b2f6e), [`db83e50`](https://github.com/enboxorg/enbox/commit/db83e508fbc8e1628ef736c46a590aad6dec432a), [`777bd26`](https://github.com/enboxorg/enbox/commit/777bd26c428c6f1562fed743831f085b683541d5), [`69c6367`](https://github.com/enboxorg/enbox/commit/69c6367a2c597ba858eed0eb28de099ab491199e), [`15817c9`](https://github.com/enboxorg/enbox/commit/15817c96e407175f4c8fb4a56a784bc56aa9959a), [`09f7002`](https://github.com/enboxorg/enbox/commit/09f700217297b8101f4689f5e8a84c8a910f2def), [`0e4f67c`](https://github.com/enboxorg/enbox/commit/0e4f67c0c76c5d56603a5d5115ee7253d90fa0c9), [`970aa97`](https://github.com/enboxorg/enbox/commit/970aa972013c61d9acc6a077f2f5ec2ae72ebf54), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`228d8dc`](https://github.com/enboxorg/enbox/commit/228d8dcd2d211f7953b86e7e7c4358d9fdb27827), [`211049b`](https://github.com/enboxorg/enbox/commit/211049bd7727c80b701e8d6be243a5c464b8bc81), [`79a860d`](https://github.com/enboxorg/enbox/commit/79a860d2a007c4eb9092d46221bda61fbb0e8348), [`5c1e8dc`](https://github.com/enboxorg/enbox/commit/5c1e8dc6bdfee56dce59d9aa963e74c7b4e7ce77), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`4ed695f`](https://github.com/enboxorg/enbox/commit/4ed695f18e4f9b2a4a2a68ca47fb39e4933e35b2), [`e781263`](https://github.com/enboxorg/enbox/commit/e78126309fc09e20be025ac2bf793632234a58f3), [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7), [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87), [`8928c5d`](https://github.com/enboxorg/enbox/commit/8928c5dfb6b5d8e44db016222bdb9acb8941f099), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801), [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549), [`49e2a4b`](https://github.com/enboxorg/enbox/commit/49e2a4be2db6692219519674e2b2f2b2db5c9c23), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`97fffdf`](https://github.com/enboxorg/enbox/commit/97fffdfa827995c75497fe22a2a7631fb7c0a22d), [`a2bfa0d`](https://github.com/enboxorg/enbox/commit/a2bfa0dafff6a60d3b0343fcade2c6e4d7d871cf), [`f90c4b8`](https://github.com/enboxorg/enbox/commit/f90c4b8a77007337b9ec7711c14885759efab383), [`4129d17`](https://github.com/enboxorg/enbox/commit/4129d1712503ad67010630f729ef37d4ea8fc27b)]:
  - @enbox/agent@0.8.1
  - @enbox/dwn-sdk-js@0.4.1
  - @enbox/dwn-clients@0.4.6

## 0.6.45

### Patch Changes

- [#1003](https://github.com/enboxorg/enbox/pull/1003) [`817e816`](https://github.com/enboxorg/enbox/commit/817e8162ed0393402d05ad903a3fd976f84fa8fc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Stop registering local and recovered identities for full-DWN sync unless an explicit identity sync protocol scope is provided.

## 0.6.44

### Patch Changes

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/agent@0.8.0
  - @enbox/dwn-sdk-js@0.4.0
  - @enbox/dwn-clients@0.4.5

## 0.6.43

### Patch Changes

- Updated dependencies [[`5908941`](https://github.com/enboxorg/enbox/commit/590894124552537f9088638b7a3527d4f7f3fda9)]:
  - @enbox/dwn-sdk-js@0.3.9
  - @enbox/agent@0.7.10
  - @enbox/dwn-clients@0.4.4

## 0.6.42

### Patch Changes

- Updated dependencies [[`4837d72`](https://github.com/enboxorg/enbox/commit/4837d725a96739c2c5fae892018087b238577e8a)]:
  - @enbox/agent@0.7.9

## 0.6.41

### Patch Changes

- Updated dependencies [[`6aaab40`](https://github.com/enboxorg/enbox/commit/6aaab40bffd77b09d05275f2d786b8091c336188), [`edd4b0f`](https://github.com/enboxorg/enbox/commit/edd4b0f27685de001bcff3cb9ca75410708043b0), [`22dffaa`](https://github.com/enboxorg/enbox/commit/22dffaa13cceb18935a20508fb131f5bb83993dd), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`1a9ba9d`](https://github.com/enboxorg/enbox/commit/1a9ba9db3aa09e7dd73e22e6f555c63eba978fb1), [`923b14f`](https://github.com/enboxorg/enbox/commit/923b14ffc986a7c98ee11a73d979d5d869579881), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`650f630`](https://github.com/enboxorg/enbox/commit/650f6306d42b6aaece08a811c437a59f4eb896b3), [`c801dc7`](https://github.com/enboxorg/enbox/commit/c801dc7045a109f210a1a6d7306f3e215bca9db7), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`67947ca`](https://github.com/enboxorg/enbox/commit/67947ca12d3e5e1343f3ade8dd8c6e261ad41ac3), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3), [`5bcc5ac`](https://github.com/enboxorg/enbox/commit/5bcc5ac00a2c478c09737e725d6df50d4d017c2f), [`92011b6`](https://github.com/enboxorg/enbox/commit/92011b6938b0e59eabf3b7ee3849f6e5f339c7a3), [`e7946e7`](https://github.com/enboxorg/enbox/commit/e7946e7e7e517be5c1c1b9c643f6e01305252ef9), [`37cac82`](https://github.com/enboxorg/enbox/commit/37cac82c0f3476f1e76eeae22665b1656a4c687e), [`31111b6`](https://github.com/enboxorg/enbox/commit/31111b651716e2a56f68fba93a43891e38c82161), [`6222ba9`](https://github.com/enboxorg/enbox/commit/6222ba9c90552e891cd4797196835544bd437a38), [`485bc75`](https://github.com/enboxorg/enbox/commit/485bc757375824265de3c294a00db9ab826620c8)]:
  - @enbox/agent@0.7.8
  - @enbox/dwn-sdk-js@0.3.8
  - @enbox/dwn-clients@0.4.3

## 0.6.40

### Patch Changes

- [#952](https://github.com/enboxorg/enbox/pull/952) [`540babf`](https://github.com/enboxorg/enbox/commit/540babff775a2943ec9688027b95c1825c29c72b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add a dedicated recovery-phrase restore path that preserves existing vault data when the phrase matches, rejects mismatched local vaults without replacing them, and exposes a wallet-friendly `restoreFromPhrase()` API. Remove the deprecated phrase import and local-connect aliases so vault recovery has one public API, while preserving delegate sync-scope repair inside the restore flow.

- Updated dependencies [[`540babf`](https://github.com/enboxorg/enbox/commit/540babff775a2943ec9688027b95c1825c29c72b)]:
  - @enbox/agent@0.7.7

## 0.6.39

### Patch Changes

- Updated dependencies [[`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02)]:
  - @enbox/dwn-sdk-js@0.3.7
  - @enbox/agent@0.7.6
  - @enbox/dwn-clients@0.4.2

## 0.6.38

### Patch Changes

- Updated dependencies [[`c1fefdb`](https://github.com/enboxorg/enbox/commit/c1fefdb1f8caec7a421ea4c2465d4d2c96a33f76)]:
  - @enbox/agent@0.7.5

## 0.6.37

### Patch Changes

- [#945](https://github.com/enboxorg/enbox/pull/945) [`9a713ce`](https://github.com/enboxorg/enbox/commit/9a713ce549e1dfe07121baa6a2837abb9b0b71a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Fix three sync issues that caused cascading errors during identity creation and seed phrase recovery:

  - **Push retry for protocol dependencies**: Protocol dependency 400 errors (`ComposedProtocolNotInstalled`, `ProtocolNotFound`) are now classified as transient and retried instead of permanently dead-lettered. This makes out-of-order protocol pushes self-healing.
  - **Push stream buffering**: `pushMessages()` now buffers data streams before sending, preventing `ReadableStream is disturbed` errors when the underlying HTTP fetch retries.
  - **Recovery KeyDeliveryProtocol**: `recoverIdentitiesFromRemote()` installs the KeyDeliveryProtocol for the agent DID before the first sync pull, so encrypted JwkProtocol records (private keys) can be committed by the closure resolver.

- Updated dependencies [[`9a713ce`](https://github.com/enboxorg/enbox/commit/9a713ce549e1dfe07121baa6a2837abb9b0b71a7)]:
  - @enbox/agent@0.7.4

## 0.6.36

### Patch Changes

- Updated dependencies [[`e58dd0a`](https://github.com/enboxorg/enbox/commit/e58dd0a517fe1fbb6c8e7c862904493b02353293)]:
  - @enbox/agent@0.7.3

## 0.6.35

### Patch Changes

- [#939](https://github.com/enboxorg/enbox/pull/939) [`749c657`](https://github.com/enboxorg/enbox/commit/749c657136988b07084d79ae3506e7c4c72c65aa) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Seed phrase recovery now happens automatically inside `vaultConnect()` and `importFromPhrase()`. When a recovery phrase is provided and no identities exist locally, the SDK pulls identity metadata, keys, and profile data from the remote DWN in a two-phase sequence. Wallets no longer need to manually orchestrate stop/pull/register/pull/push/restart after connecting with a recovery phrase.

## 0.6.34

### Patch Changes

- [#937](https://github.com/enboxorg/enbox/pull/937) [`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Register agent DID for sync in vault connect and import-from-phrase flows to enable seed phrase recovery. Rename `localConnect` to `vaultConnect` and `LocalConnectOptions` to `VaultConnectOptions` (old names preserved as deprecated aliases). Export `IdentityProtocolDefinition` and `JwkProtocolDefinition` from `@enbox/agent`.

- Updated dependencies [[`0ece8cc`](https://github.com/enboxorg/enbox/commit/0ece8cc4254bedc9fc6762b05ed0b49b43b8ca27)]:
  - @enbox/agent@0.7.2

## 0.6.33

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
  - @enbox/common@0.1.1
  - @enbox/dwn-clients@0.4.1
  - @enbox/dwn-sdk-js@0.3.6
  - @enbox/crypto@0.1.1

## 0.6.32

### Patch Changes

- Updated dependencies [[`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999)]:
  - @enbox/agent@0.7.0
  - @enbox/dwn-clients@0.4.0

## 0.6.31

### Patch Changes

- Updated dependencies [[`55f20c8`](https://github.com/enboxorg/enbox/commit/55f20c83218b97f5091aad8d450bfc32e8958c77)]:
  - @enbox/agent@0.6.8

## 0.6.30

### Patch Changes

- Updated dependencies [[`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0)]:
  - @enbox/dwn-sdk-js@0.3.5
  - @enbox/agent@0.6.7
  - @enbox/dwn-clients@0.3.3

## 0.6.29

### Patch Changes

- [#871](https://github.com/enboxorg/enbox/pull/871) [`b35f5cb`](https://github.com/enboxorg/enbox/commit/b35f5cb8eb726dd26bcb83b2082d3190a83a36f7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf: eliminate startup and reload bottlenecks

  - Cache vault `getDid()` result (avoids JWE decrypt + BearerDid.import on every call)
  - Eliminate duplicate X25519 context key derivation in `postWriteKeyDelivery()`
  - Parallelize grant processing, vault encryptions, storage writes, and post-write operations
  - Cache sync targets with 30s TTL (avoids DID resolution on every sync tick)
  - Cache `encryptionRequired` / `hasEncryptedTypes` at construction time
  - Replace protocol init TtlCache with permanent Set
  - Skip unnecessary `lock()` in `unlock()` when already locked

- [#904](https://github.com/enboxorg/enbox/pull/904) [`149e0b7`](https://github.com/enboxorg/enbox/commit/149e0b79ded21a7f558ecd8e2c5e6268b4d6ba2e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): close gaps in wildcard delegate grant handling (#897)

  - Clear stale sync registration in `importFromPhrase`/`importFromPortable`
    when a delegate has zero active grants (matches behavior in `restoreSession`
    and `importDelegateAndSetupSync`).
  - Extract `toSyncIdentityProtocols()` helper in `connect/lifecycle.ts` and use
    it across all sync-registration call sites in `connect/lifecycle.ts`,
    `connect/restore.ts`, `connect/import.ts`, and `auth-manager.ts`, eliminating
    duplicated `'all' | string[] → 'all' | [string, ...string[]]` narrowing
    casts.
  - Update stale docstring on `AuthManager._deriveProtocolsFromGrants` to
    reflect the current `'all' | string[]` return type.
  - Add test coverage for: mixed wildcard+scoped grants, expired wildcard
    grant, revoked wildcard grant, `Messages.Subscribe`/`Messages.Sync`
    unscoped grant rejection, `importFromPhrase`/`importFromPortable` wildcard
    and zero-grant flows, and `toSyncIdentityProtocols` narrowing.

- Updated dependencies [[`1240bb1`](https://github.com/enboxorg/enbox/commit/1240bb167ffedc051f5a1e4beb08463080d18ae0), [`b35f5cb`](https://github.com/enboxorg/enbox/commit/b35f5cb8eb726dd26bcb83b2082d3190a83a36f7)]:
  - @enbox/agent@0.6.6

## 0.6.28

### Patch Changes

- Updated dependencies [[`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d)]:
  - @enbox/dwn-sdk-js@0.3.4
  - @enbox/agent@0.6.5
  - @enbox/dwn-clients@0.3.2

## 0.6.27

### Patch Changes

- [#867](https://github.com/enboxorg/enbox/pull/867) [`b9c667f`](https://github.com/enboxorg/enbox/commit/b9c667f6dc7994b257fefd19ed6db35a19477d98) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: exclude permissions protocol from delegate sync targets

  processConnectedGrants was including the DWN permissions protocol
  in connectedProtocols because submitConnectResponse creates a
  revocation grant scoped to PermissionsProtocol.uri. This caused the
  sync engine to register the permissions protocol as a sync target,
  which then failed with "No permissions found for MessagesSync".

  Permission records are already included in each protocol's sync stream
  via PermissionsProtocol.constructAdditionalMessageFilter() in the DWN
  SDK — no separate sync target is needed.

## 0.6.26

### Patch Changes

- [#865](https://github.com/enboxorg/enbox/pull/865) [`7452b53`](https://github.com/enboxorg/enbox/commit/7452b53b7e574a220f5bc98bbc80c8a033bfd5db) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: restore path updates stale sync registration, handle QR connect denial

  - Session restore now derives the protocol list from stored grants and
    updates the sync registration before starting sync. This fixes stale
    `protocols: []` (global sync) registrations from prior sessions that
    caused the sync engine to attempt the permissions protocol and fail.
  - WalletConnect.initClient recognizes `DENIED` token from the relay
    callback, returning undefined immediately instead of prompting for PIN.
  - Updated denial error message to "Connection was denied by the wallet."

## 0.6.25

### Patch Changes

- [#863](https://github.com/enboxorg/enbox/pull/863) [`e582ab0`](https://github.com/enboxorg/enbox/commit/e582ab05e6f242ee99e00dc0e94853ee2dcc5e51) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: scope delegate sync to granted protocols instead of global sync

  The sync engine was attempting to sync all protocols (including the DWN
  permissions protocol) for delegate sessions. This happened because:

  1. `switchIdentity` / session restore registered delegates with
     `protocols: []` (global sync) instead of deriving the protocol list
     from stored grants.
  2. `importDelegateAndSetupSync` correctly passed `connectedProtocols`,
     but if the identity was already registered from a prior session with
     `protocols: []`, the stale registration persisted.

  Now:

  - `switchIdentity` derives the protocol list from stored grants by
    querying the delegate's DWN for grant records and extracting
    `scope.protocol` (excluding the permissions protocol itself).
  - `importDelegateAndSetupSync` falls back to `updateIdentityOptions`
    when the identity is already registered, ensuring the protocol
    list is always current.

## 0.6.24

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/dwn-sdk-js@0.3.3
  - @enbox/agent@0.6.4
  - @enbox/dwn-clients@0.3.1

## 0.6.23

### Patch Changes

- Updated dependencies [[`57b1b52`](https://github.com/enboxorg/enbox/commit/57b1b52dcf80f2a4e995d649bb64c9e0b9eac9d8)]:
  - @enbox/agent@0.6.3

## 0.6.22

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

- Updated dependencies [[`140bd84`](https://github.com/enboxorg/enbox/commit/140bd8474d0a333fe0b5428e1835d8176d269293), [`928f72f`](https://github.com/enboxorg/enbox/commit/928f72fb81beb7a979908e323ebe6510358b31b6)]:
  - @enbox/agent@0.6.2

## 0.6.21

### Patch Changes

- Updated dependencies [[`d3ae193`](https://github.com/enboxorg/enbox/commit/d3ae193f546443e0a3ceb059cd721aaae2844ae3)]:
  - @enbox/agent@0.6.1

## 0.6.20

### Patch Changes

- Updated dependencies [[`963d366`](https://github.com/enboxorg/enbox/commit/963d366de71e9e6c077e0ed1ad11904e8a587c92), [`f7b4c79`](https://github.com/enboxorg/enbox/commit/f7b4c79f5a11a4d3de7836bb1ee56e47c90faf3b), [`28fd8ed`](https://github.com/enboxorg/enbox/commit/28fd8ed952df6ea032f246180370169758a1b0f8)]:
  - @enbox/agent@0.6.0
  - @enbox/dwn-clients@0.3.0

## 0.6.19

### Patch Changes

- Updated dependencies [[`1c567c0`](https://github.com/enboxorg/enbox/commit/1c567c008e60738e7fbbba5f511cf201c96f183e)]:
  - @enbox/agent@0.5.16

## 0.6.18

### Patch Changes

- [#804](https://github.com/enboxorg/enbox/pull/804) [`98eb9be`](https://github.com/enboxorg/enbox/commit/98eb9be0c616da886db5d43e3186874e050d44c2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: add delete to default connect permissions and quiet singleton push warnings

  Adds `'delete'` to `DEFAULT_PERMISSIONS` in `@enbox/auth` so apps using
  bare protocol definitions in `auth.connect()` get `Records.Delete` grants
  by default. Downgrades `RecordLimitExceeded` sync push warnings to debug
  level in `@enbox/agent` — these are expected in multi-device singleton
  convergence scenarios.

- Updated dependencies [[`98eb9be`](https://github.com/enboxorg/enbox/commit/98eb9be0c616da886db5d43e3186874e050d44c2)]:
  - @enbox/agent@0.5.15

## 0.6.17

### Patch Changes

- Updated dependencies [[`6b77eee`](https://github.com/enboxorg/enbox/commit/6b77eeed4d0ae4b99b14631b41eb7ebaf0dd9587)]:
  - @enbox/agent@0.5.14

## 0.6.16

### Patch Changes

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/dwn-sdk-js@0.3.2
  - @enbox/agent@0.5.13
  - @enbox/dwn-clients@0.2.6

## 0.6.15

### Patch Changes

- Updated dependencies [[`43d805e`](https://github.com/enboxorg/enbox/commit/43d805e51b63c358f1c9c1a51623d0c5f44446fe)]:
  - @enbox/agent@0.5.12

## 0.6.14

### Patch Changes

- Updated dependencies [[`5818860`](https://github.com/enboxorg/enbox/commit/5818860e2bca5201ff368d4748393efb1544d7a2)]:
  - @enbox/dwn-sdk-js@0.3.1
  - @enbox/dwn-clients@0.2.5
  - @enbox/agent@0.5.11

## 0.6.13

### Patch Changes

- Updated dependencies [[`3199425`](https://github.com/enboxorg/enbox/commit/319942541442670d8f1fd203adc522781d3cee72)]:
  - @enbox/agent@0.5.10

## 0.6.12

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/dwn-sdk-js@0.3.0
  - @enbox/agent@0.5.9
  - @enbox/dwn-clients@0.2.4

## 0.6.11

### Patch Changes

- Updated dependencies [[`3ce537a`](https://github.com/enboxorg/enbox/commit/3ce537a4f5e5137b6cedf65af50c33ddbdf6a6a2)]:
  - @enbox/agent@0.5.8

## 0.6.10

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

- Updated dependencies [[`e269cbf`](https://github.com/enboxorg/enbox/commit/e269cbf58cf7c29fc0e1e7865ecfa7f42ea54122)]:
  - @enbox/agent@0.5.7

## 0.6.9

### Patch Changes

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

- Updated dependencies [[`682fb85`](https://github.com/enboxorg/enbox/commit/682fb858343319e3a4da54b08017382596896d6a), [`c8360c3`](https://github.com/enboxorg/enbox/commit/c8360c3856eebec89d717003fe3e0e21a9f182fe)]:
  - @enbox/agent@0.5.6

## 0.6.8

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

- Updated dependencies [[`3910ebb`](https://github.com/enboxorg/enbox/commit/3910ebb5b25d29161359d7ffa426ac85534f16a6)]:
  - @enbox/agent@0.5.5

## 0.6.7

### Patch Changes

- Updated dependencies [[`d6b643d`](https://github.com/enboxorg/enbox/commit/d6b643ddab34bf8d82226c368727a3566ae84d48)]:
  - @enbox/agent@0.5.4

## 0.6.6

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2
  - @enbox/agent@0.5.3
  - @enbox/dwn-clients@0.2.3

## 0.6.5

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1
  - @enbox/agent@0.5.2
  - @enbox/dwn-clients@0.2.2

## 0.6.4

### Patch Changes

- [#738](https://github.com/enboxorg/enbox/pull/738) [`5f3e33e`](https://github.com/enboxorg/enbox/commit/5f3e33edf3dee9268716c8ac8c049da3abf010e4) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): allow sync: 'off' for delegated connect flows

  Remove the restriction that forced sync to be enabled for
  walletConnect() and handler-based connect(). The sync engine's
  SMT tree walk generates hundreds of HTTP requests during initial
  reconciliation, easily exceeding DWN server rate limits.

  Dapps can now opt out of sync with `sync: 'off'` and rely on
  local DWN operations only. The `startSyncIfEnabled()` helper
  already handles sync: 'off' as a no-op.

## 0.6.3

### Patch Changes

- [#736](https://github.com/enboxorg/enbox/pull/736) [`4c7c71e`](https://github.com/enboxorg/enbox/commit/4c7c71efa25a1eee115ef30424bc6c97189aa8f3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): remove redundant sync pull from importDelegateAndSetupSync

  The manual `sync('pull')` call was immediately followed by
  `startSyncIfEnabled()` which runs its own immediate sync cycle.
  This doubled the startup burst and could trigger 429 rate limits
  on the remote DWN server.

## 0.6.2

### Patch Changes

- [#728](https://github.com/enboxorg/enbox/pull/728) [`ef5dc9b`](https://github.com/enboxorg/enbox/commit/ef5dc9b28527538205c0e08032017649ba20964d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(auth): add 'configure' to DEFAULT_PERMISSIONS

  Include `ProtocolsConfigure` in the default permission set requested
  during `connect()`. Without this, dapps using the standard `TypedEnbox`
  API fail with "No permissions found for ProtocolsConfigure" because
  `_autoConfigureOnce()` needs a configure grant to install the protocol
  on the delegate's local DWN.

## 0.6.1

### Patch Changes

- Updated dependencies [[`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7), [`fc923cb`](https://github.com/enboxorg/enbox/commit/fc923cb6a1f6d8e56f616a69d3e61345898d2cf9)]:
  - @enbox/agent@0.5.1
  - @enbox/dwn-clients@0.2.1

## 0.6.0

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
  - @enbox/dwn-clients@0.2.0
  - @enbox/common@0.1.0
  - @enbox/crypto@0.1.0
  - @enbox/dwn-sdk-js@0.2.0
  - @enbox/dids@0.1.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [[`fd02228`](https://github.com/enboxorg/enbox/commit/fd02228b247aa5de903051155813ce49f210b62c)]:
  - @enbox/agent@0.4.0

## 0.4.0

### Minor Changes

- [#667](https://github.com/enboxorg/enbox/pull/667) [`2d2d4b1`](https://github.com/enboxorg/enbox/commit/2d2d4b1fd1400d1d8983ed17576a329da226b104) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add `lock()`, `switchIdentity()` sync registration, and `onPasswordRequired` callback

  - **`AuthManager.lock()`**: New top-level method that stops sync, clears the active session, locks the vault, and transitions to `'locked'` state. Session storage markers are preserved so `restoreSession()` can reconnect after unlock.
  - **`switchIdentity()` sync registration**: Now calls `sync.registerIdentity()` for the target identity before starting sync, ensuring imported or newly-switched identities are properly registered for DWN synchronization.
  - **`onPasswordRequired` callback**: New optional callback on `RestoreSessionOptions` that is invoked when the vault is locked and a password is needed. This enables interactive password prompts (PIN dialogs, CLI prompts) without pre-supplying a password.

## 0.3.1

### Patch Changes

- Updated dependencies [[`22d724e`](https://github.com/enboxorg/enbox/commit/22d724eb415b3eea71983ab6aecd5810efa8c6bc)]:
  - @enbox/agent@0.3.1

## 0.3.0

### Minor Changes

- [#594](https://github.com/enboxorg/enbox/pull/594) [`d20a8b9`](https://github.com/enboxorg/enbox/commit/d20a8b9299db09290303e679115a5eeb144c2469) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Support custom agent, vault, and local DWN strategy in AuthManager.create()

  - Add `agent`, `agentVault`, and `localDwnStrategy` options to `AuthManagerOptions`
  - When a pre-built `Web5UserAgent` is provided, it is used as-is (escape hatch for custom DWN stores)
  - Re-export `Web5UserAgent` and `HdIdentityVault` classes from `@enbox/agent` so consumers don't need a direct dependency
  - Re-export `LocalDwnStrategy` type
  - 5 new tests covering all custom agent creation paths, 169 total tests passing

- [#584](https://github.com/enboxorg/enbox/pull/584) [`b147be2`](https://github.com/enboxorg/enbox/commit/b147be2d2e5cb20d9265b86bf38cedc42b19b178) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add DWN registration support to all connection flows

  - Expand `RegistrationOptions` with provider-auth callbacks (`onProviderAuthRequired`, `registrationTokens`, `onRegistrationTokens`)
  - Add `ProviderAuthParams`, `ProviderAuthResult`, and `RegistrationTokenData` types
  - Create `registerWithDwnEndpoints()` flow supporting provider-auth-v0 (with token refresh) and PoW fallback
  - Wire registration into `connect()`, `walletConnect()`, `importFromPhrase()`, and `importFromPortable()` flows
  - Add `@enbox/dwn-clients` as a dependency for `DwnRegistrar`
  - Add `rpc.getServerInfo` mock to test helper
  - 17 new tests covering all registration paths, 99.68% line coverage

### Patch Changes

- [#582](https://github.com/enboxorg/enbox/pull/582) [`a48bdd4`](https://github.com/enboxorg/enbox/commit/a48bdd4b6f9261821ad9470ce849699bc045c80f) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add LevelDB-backed `LevelStorage` adapter as the default storage for Node/CLI environments, replacing the in-memory fallback that lost session data on process exit.

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

- Updated dependencies [[`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b), [`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/agent@0.3.0
  - @enbox/dwn-clients@0.1.0
  - @enbox/common@0.0.7
  - @enbox/dids@0.0.9

## 0.2.0

### Minor Changes

- [#579](https://github.com/enboxorg/enbox/pull/579) [`68b0ea9`](https://github.com/enboxorg/enbox/commit/68b0ea9728f95d81fa6d7657df8bc78ba2f83814) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: introduce @enbox/auth — headless authentication & identity SDK

  New package providing composable, multi-identity-aware authentication that replaces `Web5.connect()`. Depends only on `@enbox/agent`, `@enbox/common`, and `@enbox/dids` with zero dependency on `@enbox/api`.

  Key capabilities:

  - `AuthManager` orchestrator with local connect, wallet connect, import, and session restore flows
  - `AuthSession` exposing `agent`, `did`, `delegateDid` primitives (no `web5` getter — that's `@enbox/api`'s layer)
  - Multi-identity support: list, switch, delete, export identities
  - `VaultManager` wrapping `HdIdentityVault` with typed events
  - Platform-agnostic `StorageAdapter` with browser and memory implementations
  - `processConnectedGrants()` reimplemented using agent primitives
