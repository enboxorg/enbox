# @enbox/dwn-server

## 0.1.29

### Patch Changes

- [#1364](https://github.com/enboxorg/enbox/pull/1364) [`535922a`](https://github.com/enboxorg/enbox/commit/535922a5c7c4312bac6155cfa34cff38bf458080) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: wake-triggered WebSocket liveness checks and immediate dead-peer teardown

  The socket heartbeat rides on JS timers, which browsers throttle or freeze in
  backgrounded tabs and across system sleep — a dead connection could go
  undetected for 60–100s while subscriptions silently missed events.

  - `JsonRpcSocket.checkHealth()` forces an immediate liveness verdict: a live
    connection is probed with a short-deadline `rpc.ping` (a miss force-closes
    and hands off to auto-reconnect), a reconnecting socket has its pending
    backoff wait fast-forwarded, and a disconnected socket starts a fresh
    reconnect loop. A probe pong supersedes an outstanding heartbeat entirely —
    deadline cleared and its pong handler removed, with heartbeat generations
    tracked by ping id — so a deadline armed before a tab freeze cannot kill a
    verified-alive connection on resume and a late stale pong cannot defuse a
    newer heartbeat's deadline.
  - `WebSocketDwnRpcClient` registers browser wake listeners (network back
    online, tab foregrounded) that run `checkAllConnections()` across the pool
    AND a registry of sockets evicted from the pool mid-reconnect — the sockets
    parked in backoff are exactly the ones a wake must reach. Recovery starts
    the moment the page wakes instead of at the next throttled timer tick.
    `closeAllConnections()` removes the listeners and also closes reconnecting
    sockets so none survive shutdown to re-register into a cleared pool — and a
    reconnect already past its backoff cannot undo a close that raced it:
    establishment re-checks closure, discards the fresh WebSocket, and a
    user-closed socket is never re-registered by `onreconnected`.
  - Exactly one socket per endpoint survives a reconnect racing a replacement
    connection: pool mutations are ownership-checked, so a superseded
    reconnected socket closes instead of overwriting the replacement, a
    completing replacement closes the socket it displaces, and a stale close
    cannot evict a connection it no longer owns. A tracked subscription is a
    stable logical identity across every re-establishment: the caller's
    original close() handle always targets the current transport
    subscription, the cursor watermark carries over so resumptions never
    fall back to an uncursored subscribe, and a late terminal error from a
    superseded establishment cannot kill a recovered one. The losing
    socket's subscriptions transfer to the winner (a replacement completing
    after the endpoint already recovered is discarded in favor of the
    recovered connection — no duplicate resubscription); a subscription
    caught mid-resubscription re-routes to the current owner; and a failed
    re-establishment (e.g. a 410 progress gap) never masquerades as a
    reconnection — the consumer receives a terminal
    `SubscriptionRecoveryFailed` error that drives repair. Requests against
    a closed or reconnecting socket now fail fast instead of waiting out the
    response timeout.
  - `dwn-server` heartbeat now `terminate()`s a dead peer instead of initiating
    a close handshake the peer can never complete.

- Updated dependencies [[`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca), [`535922a`](https://github.com/enboxorg/enbox/commit/535922a5c7c4312bac6155cfa34cff38bf458080)]:
  - @enbox/dwn-clients@0.4.21
  - @enbox/dwn-sdk-js@0.4.14
  - @enbox/dwn-sql-store@0.0.39

## 0.1.28

### Patch Changes

- [#1283](https://github.com/enboxorg/enbox/pull/1283) [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat(agent): graceful, self-healing handling of quota-blocked sync pushes + observable per-remote sync status

  Sync pushes rejected for tenant storage/message quota are no longer retried forever (the console-error flood that spun the remote). They are now detected precisely (`isQuotaExceededError`, newly exported from `@enbox/dwn-clients`) and deferred on a per-link, per-message exponential-backoff probe. Feed checkpoints may advance past the explicit omission, so a blocked message neither stalls newer records nor prevents other remotes from progressing; due and manual retries target the omitted CID independently of that checkpoint. If a later update or tombstone makes the old bytes unreachable, its acknowledgement converts the block into a resolved per-link omission: it is healthy, never retried, and remains durable only long enough to explain the intentional feed-CID difference.

  Live sync now suppresses the remote subscription echo of messages already materialized in the same local tenant when it pushes them to that endpoint. The matching pull delivery still advances its durable checkpoint, but it no longer performs a redundant remote `MessagesRead` or re-applies data already present in the local DWN; tenant- and endpoint-scoped tracking preserves multi-identity isolation and normal multi-provider fan-out. Canonicalized bootstrap messages that may not exist in the destination tenant still follow normal pull admission. Pull deliveries accepted while a link is still initializing are also committed, preventing an early event from pinning every later checkpoint behind an unfinished ordinal.

  Replicated metadata-only historical writes continue through storage-quota preflight without charging their declared payload size, while message-count quota and all normal data-bearing quota checks remain enforced. This lets a later tombstone or smaller update replay its retained initial-write dependency without exposing a dataless current record. Same-CID data retries against ancestry-only storage are deferred instead of falsely acknowledged, embedded message data is rejected in favor of the validated transport field, and storage reporting now counts only latest base-state data rather than metadata-only history.

  New observability, re-exported through `@enbox/browser` for dapp "remotes" panels: `SyncEngine.getRemoteSyncStatus()` returns a per-`(tenant, remote)` snapshot (`healthy | quota-blocked | degraded | offline`, blocked count, next-probe time, last error/activity); `SyncEngine.retryRemoteNow()` directly re-probes only the selected remote; `push:quota-blocked` / `push:quota-cleared` events include durable timing and clear resolution; and `SyncHealthSummary` gains `quotaBlockedMessageCount`.

  Also fixes a latent bug in the push dependency-fetch path: the four local dependency queries (`fetchProtocolConfig`, `fetchRecordsByRecordId`, `fetchRoleRecord`, `fetchRecordData`) passed `store: false`, which makes `AgentDwnApi.processRequest` short-circuit to a synthetic `202` reply with no entries instead of executing the query — so every attempt to satisfy a remote `Incomplete` missing-dependency from the local DWN silently returned `failed`. Dropping `store: false` lets those local queries run (read/query handlers persist nothing, so there is no side effect). The bug was masked because unit tests stub `processRequest`; the added live-sync/quota convergence coverage now exercises the real path.

- [#1318](https://github.com/enboxorg/enbox/pull/1318) [`ff73ebe`](https://github.com/enboxorg/enbox/commit/ff73ebed4a2108bba3395e95e65a5ee4d07b8ed0) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity of the admin-API router (Sonar S3776)

  Behavior-preserving decomposition of `AdminApi.route` (was CC 76) to ≤15 via a
  two-level dispatch: `route` keeps the `/admin/api` prefix strip, the unauthenticated
  passkey-login checks, the `validateAdminAuth` gate/audit/401 handling, and the
  try/catch, then delegates the authenticated dispatch to `#dispatchAuthenticatedRoutes`,
  which calls seven cohesive `#match*Routes` helpers in the EXACT original top-to-bottom
  order and ends with the original 404. Every route check is byte-identical and in its
  original relative position — no route was hoisted, reordered, weakened, or dropped, and
  the per-route auth-method (403) checks are preserved verbatim.

  The dispatcher and matchers are synchronous and return matched handlers as unawaited
  promises, so the original error-handling contract is preserved exactly: errors thrown
  synchronously while matching are still caught by `route` (JSON 500), while async handler
  rejections still propagate to `HttpApi` (plain-text 500 + method/path logging) rather
  than being swallowed into AdminApi's JSON 500. A regression test covers this contract.

  Verified: dwn-server build + lint clean; all 265 admin tests pass (incl. admin-api
  routing + the async-error-contract test).

- [#1312](https://github.com/enboxorg/enbox/pull/1312) [`b16d24b`](https://github.com/enboxorg/enbox/commit/b16d24b66dc1b29d751fec9e064d8ee09333cccb) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity in server routing/admin (Sonar S3776)

  Behavior-preserving extract-method refactoring of 6 functions (CC 16–39) to the ≤15
  threshold: the connect-route dispatcher (`#matchConnectRoutes`), server setup
  (`#setupServer`), delivery-target resolution, the JSON-RPC process-message handler,
  and the admin tenant-list / config-patch handlers. Extracted route/validation helpers
  return `Response | null` (or `T | Response`) with the route guard as their first
  statement — no side effect runs before a route matches, and all status codes, error
  bodies, checks, and evaluation order are preserved verbatim.

  Defers the monster functions `admin/admin-api.ts:167` (CC 76),
  `delivery-service.ts:547` (CC 48), and `http-api.ts:389` (CC 43).

  Verified: dwn-server build + lint clean; server test suite runs in CI.

- [#1317](https://github.com/enboxorg/enbox/pull/1317) [`07bc586`](https://github.com/enboxorg/enbox/commit/07bc586ba4b0cf15e615d12c5a4644266581a33a) Thanks [@poindex-bot](https://github.com/poindex-bot)! - refactor: reduce cognitive complexity of the HTTP router and DWN-endpoint extractor (Sonar S3776)

  Behavior-preserving extract-method refactoring of two large functions to ≤15:

  - `#route` (was CC 43) — the main HTTP router, split into per-group matchers
    (`#matchStaticRoutes`, `#matchLocalNodeConvenienceRoutes`, `#matchAdminRoutes`,
    `#matchProviderAuthRoutes`, plus `#handleMetrics`) that return `Response | null`;
    `#route` dispatches with `if (result) return result;`, preserving the exact match
    order and fall-through so every request maps to the same handler and status code.
  - `#extractDwnEndpoints` (was CC 48) — split the per-service / array / object
    `serviceEndpoint` parsing into helpers, deduplicating the map-entry construction,
    preserving the exact accept/reject rules and the `nodes`-before-`url` endpoint order.

  Boolean transforms are single-condition/compound negations (exact by double-negation),
  not De Morgan distributions. No check reordered/weakened; no status code or response body changed.

  Verified: dwn-server build + lint clean; delivery-service + http-api test suites pass
  (127 tests, directly covering both functions).

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

- Updated dependencies [[`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441), [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`f6c1c59`](https://github.com/enboxorg/enbox/commit/f6c1c59962f56e39327461b5536b0fefb5b099a7), [`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c), [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67), [`537c16f`](https://github.com/enboxorg/enbox/commit/537c16f2406e29edf6f2f867c2fba35915104165), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0), [`b5f49ac`](https://github.com/enboxorg/enbox/commit/b5f49ace4e6ab9e1caf23afb2cdd8735d44985b3)]:
  - @enbox/dwn-sdk-js@0.4.13
  - @enbox/dwn-clients@0.4.20
  - @enbox/crypto@0.1.7
  - @enbox/dids@0.1.7
  - @enbox/dwn-sql-store@0.0.38
  - @enbox/common@0.1.4

## 0.1.27

### Patch Changes

- [#1280](https://github.com/enboxorg/enbox/pull/1280) [`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(replication): move negotiated HTTP RPC envelopes into a streaming request body and stop replaying dependencies the remote has already acknowledged

  HTTP clients now negotiate `body-v1` through the server's `/info` response. Supporting peers send the JSON-RPC envelope and optional raw record data in one length-prefixed, streaming body, avoiding proxy header limits without buffering or base64-expanding large attachments. Older servers continue to receive the legacy `dwn-request` header format.

  The agent now treats `Applied`, `Duplicate`, and `Superseded` dependency results as acknowledgements. If a root continues to report only acknowledged dependencies as missing, it is handed to delayed reconciliation instead of consuming the admission pass budget and immediate retry ladder.

- Updated dependencies [[`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131)]:
  - @enbox/dwn-clients@0.4.19

## 0.1.26

### Patch Changes

- [#1278](https://github.com/enboxorg/enbox/pull/1278) [`f18cece`](https://github.com/enboxorg/enbox/commit/f18ceceeae21b85aa9898decffe479f6fb729bff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(connect): answer the token poll with 204 (not 404) while the wallet response is pending

  The relay's `GET /connect/token/{state}.jwt` route now returns `204 No Content`
  (empty body) while the wallet has not yet posted its sealed response, instead of
  `404 Not Found`. The requesting app long-polls this route, so "not ready yet" is
  the steady state of that loop — not an error — and the 404 was surfaced by
  browsers as console noise on every poll. This matches the always-2xx contract the
  sibling `/connect/status` and `/connect/complete` observation routes already use;
  an unknown or already-consumed state reads the same clean 204.

  `@enbox/connect`'s relay transport now treats an empty 2xx (204) as "keep
  polling" and resolves the handshake only on a non-empty body, so it works against
  both current relays (204) and older relays that still answer 404.

  Rollout: ship the `@enbox/connect` change to apps **before** the relay flips to 204. A client that predates this change treats any 2xx as a completed response
  and would misread the empty 204 body as an empty token.

## 0.1.25

### Patch Changes

- Updated dependencies [[`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081)]:
  - @enbox/crypto@0.1.6
  - @enbox/dids@0.1.6
  - @enbox/dwn-clients@0.4.18
  - @enbox/dwn-sdk-js@0.4.12
  - @enbox/dwn-sql-store@0.0.37

## 0.1.24

### Patch Changes

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11
  - @enbox/dwn-sql-store@0.0.36
  - @enbox/dwn-clients@0.4.17

## 0.1.23

### Patch Changes

- [#1263](https://github.com/enboxorg/enbox/pull/1263) [`fbbad6f`](https://github.com/enboxorg/enbox/commit/fbbad6f735e4cebba3671fe42b989c381b553919) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: bidirectional completion signals for the connect handshake. The relay gains an observational completion marker (`POST /connect/complete` + `GET /connect/complete/{state}`, mirroring the claimed marker): clients signal it automatically after successfully opening the wallet's response (`ConnectTransport.confirmComplete`, wired into `ConnectClient` and the browser relay runner, `keepalive` so it survives immediate navigation), and wallets can poll `pollRelayComplete` to flip their pairing screen to a confirmed "connected" state instead of asking the user to dismiss it blind. The popup channel gets the same signal as a payload-less `enbox-connect-ack` postMessage: dapps send it automatically, and wallets can await it via `WalletPostMessageTransport.sendResponseAwaitingAck` to show confirmed success before closing themselves. All signals are best-effort and backward compatible — older relays, wallets, and dapps simply never see them. The relay's connect store now awaits its TTL-cache writes and deletes, closing a race where the PAR response could outrun the request insert (a wallet dereferencing the pointer immediately read a false 404) and hardening the single-use pointer guarantee.

## 0.1.22

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

## 0.1.21

### Patch Changes

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/dwn-sdk-js@0.4.10
  - @enbox/dwn-clients@0.4.16
  - @enbox/dids@0.1.5
  - @enbox/dwn-sql-store@0.0.35

## 0.1.20

### Patch Changes

- [#1224](https://github.com/enboxorg/enbox/pull/1224) [`7da7893`](https://github.com/enboxorg/enbox/commit/7da789309cafaccc62eadc97bebc6eda20a06944) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: auto-approve configured local-node pairing origins over HTTP

- [#1228](https://github.com/enboxorg/enbox/pull/1228) [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Harden local-node ejection with authenticated stable drains, safe outage fallback, persisted consent, native token discovery, and durable local storage.

- [#1222](https://github.com/enboxorg/enbox/pull/1222) [`f2f6252`](https://github.com/enboxorg/enbox/commit/f2f6252411aef80c1a94362eaba1ec713b6f3489) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: require matching origins when polling local-node pairing requests

- [#1220](https://github.com/enboxorg/enbox/pull/1220) [`f504edd`](https://github.com/enboxorg/enbox/commit/f504edd7b113f13f216f608c7d8c95ffa90b5103) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: persist local-node browser pairing sessions across restarts

- [#1211](https://github.com/enboxorg/enbox/pull/1211) [`8da3f92`](https://github.com/enboxorg/enbox/commit/8da3f927e5c22c9f9196294e348135e800f12a46) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add local-node pairing endpoints and bearer-token enforcement

- [#1208](https://github.com/enboxorg/enbox/pull/1208) [`98f4348`](https://github.com/enboxorg/enbox/commit/98f4348bfbfb7d5ddbc91787f4187958998ba011) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: add the local-node server profile skeleton

- [#1217](https://github.com/enboxorg/enbox/pull/1217) [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add browser local-node probing, pairing persistence, and token-authenticated DWN transports

- [#1221](https://github.com/enboxorg/enbox/pull/1221) [`9012b3a`](https://github.com/enboxorg/enbox/commit/9012b3a10f41797a12854e9d9ab97f9c140d2e9d) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: close local-node WebSocket connections when pairing tokens are revoked

- [#1215](https://github.com/enboxorg/enbox/pull/1215) [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve SonarCloud maintainability issues (S3863/S6594)

  Behavior-preserving source cleanups:

  - S3863: merge duplicate `import` statements from the same module into a
    single statement (re-sorting to satisfy the repo's `sort-imports` rule).
  - S6594: use `RegExp.exec()` instead of `String#match()` for the non-global
    route/type regexes in the DWN server and `universalTypeOf`.

- [#1209](https://github.com/enboxorg/enbox/pull/1209) [`e6eb37c`](https://github.com/enboxorg/enbox/commit/e6eb37c99aa64844d8257daae45336e0a857a9db) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix(dwn-server): avoid passing `nestObj` directly to `Array.prototype.reduce`

  Wrap the query-param nesting helper in an explicit two-argument arrow so
  `reduce`'s extra `index`/`array` arguments can never reach it. Behavior is
  unchanged; this hardens the protocol-record and records-query handlers against
  the class of bugs SonarCloud rule S7727 flags.

- [#1212](https://github.com/enboxorg/enbox/pull/1212) [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve remaining SonarCloud reliability issues (S7773/S7781/S7758/S6853/S8786)

  Behavior-preserving reliability hardening across packages:

  - Replace global `parseInt`/`isNaN` with `Number.parseInt`/`Number.isNaN` (S7773).
  - Replace `String#replace(/…/g)` and `split().join()` with `String#replaceAll` (S7781).
  - Prefer `String.fromCodePoint`/`String#codePointAt` in byte-range encoders (S7758).
  - Associate admin-UI form labels with their inputs via `for`/`id` (S6853).
  - Strip trailing slashes in the local-node `/info` handler with a linear loop
    instead of a backtracking-prone regex (S8786).

- Updated dependencies [[`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a), [`98f4348`](https://github.com/enboxorg/enbox/commit/98f4348bfbfb7d5ddbc91787f4187958998ba011), [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9), [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/dwn-clients@0.4.15
  - @enbox/common@0.1.3
  - @enbox/dids@0.1.4
  - @enbox/dwn-sdk-js@0.4.9
  - @enbox/dwn-sql-store@0.0.34
  - @enbox/crypto@0.1.4

## 0.1.19

### Patch Changes

- [#1199](https://github.com/enboxorg/enbox/pull/1199) [`1ed6eb3`](https://github.com/enboxorg/enbox/commit/1ed6eb3dd31c7b4159b5198a212943251cae44e5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: forward record data with DeliveryService messages

  Endpoint forwarding and `$delivery: 'direct'` participant delivery previously POSTed data-bearing `RecordsWrite` messages with an empty body, so receiving DWNs only ever got metadata. `DeliveryService` now reads the record data back from the source tenant's stores (`encodedData` for small records, the data store for large ones) and sends it as the `application/octet-stream` request body.

## 0.1.18

### Patch Changes

- Updated dependencies [[`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/dwn-sdk-js@0.4.8
  - @enbox/dwn-clients@0.4.14
  - @enbox/dwn-sql-store@0.0.33

## 0.1.17

### Patch Changes

- Updated dependencies [[`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979)]:
  - @enbox/dwn-clients@0.4.13

## 0.1.16

### Patch Changes

- [#1121](https://github.com/enboxorg/enbox/pull/1121) [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: dedupe runtime dependency versions and pin dependency declarations

- [#1120](https://github.com/enboxorg/enbox/pull/1120) [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency footprint by moving optional backends behind subpath imports and optional peer dependencies, removing unused DID and helper packages, and replacing small CLI/runtime dependencies with built-in implementations.

- [#1146](https://github.com/enboxorg/enbox/pull/1146) [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: isolate Level-backed DWN and DID store implementations behind explicit subpath exports

- [#1142](https://github.com/enboxorg/enbox/pull/1142) [`f3f43ec`](https://github.com/enboxorg/enbox/commit/f3f43ec98ff00170659731909340390080782a00) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: make WebAuthn admin passkey support use an optional peer dependency

- [#1135](https://github.com/enboxorg/enbox/pull/1135) [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: reduce runtime dependency surface for SDK cache, wake publisher, server logging, and SQL store manifests.

- [#1140](https://github.com/enboxorg/enbox/pull/1140) [`6058cca`](https://github.com/enboxorg/enbox/commit/6058ccae05100208de7dd2f78dce011f6a2a3dda) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: upgrade Kysely to a patched pinned version.

- Updated dependencies [[`d006765`](https://github.com/enboxorg/enbox/commit/d00676570a8645ab440e017695351828354a2251), [`7ddb0d6`](https://github.com/enboxorg/enbox/commit/7ddb0d677065483968ef9d80773e3fd81048f4ad), [`37895ff`](https://github.com/enboxorg/enbox/commit/37895ff511258ed48d10660b1f73ce597e818921), [`cda1d31`](https://github.com/enboxorg/enbox/commit/cda1d31b4c8a7df444beadd0271ff50a3482fa00), [`5de6973`](https://github.com/enboxorg/enbox/commit/5de6973f98216a3732800a6ec461520b47171902), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`042879e`](https://github.com/enboxorg/enbox/commit/042879ea1e05d45b99ab35e23f1ab2f730afa757), [`efa5171`](https://github.com/enboxorg/enbox/commit/efa5171b36aa0f46e957e74506323f9cbd4d8dc7), [`97dced6`](https://github.com/enboxorg/enbox/commit/97dced6b0eb80fccbd71ea5a8a1c250ba40153bb), [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e), [`78cd3e5`](https://github.com/enboxorg/enbox/commit/78cd3e5b8412b308077f318b58bf5fd3db63d996), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`23ae738`](https://github.com/enboxorg/enbox/commit/23ae7389a4c14aedf360c5b3b3bbdd8c274ef53a), [`b38dd5e`](https://github.com/enboxorg/enbox/commit/b38dd5ec24129a37e8e2bb17b3173144ac9bb863), [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`96bc5f5`](https://github.com/enboxorg/enbox/commit/96bc5f5c2d80f0cb543042e3f41f5c2d4156c3d3), [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6), [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c), [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688), [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852), [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46), [`57c66a3`](https://github.com/enboxorg/enbox/commit/57c66a34079625793c8b26028f29d1eb63b969ef), [`6058cca`](https://github.com/enboxorg/enbox/commit/6058ccae05100208de7dd2f78dce011f6a2a3dda)]:
  - @enbox/dids@0.1.3
  - @enbox/dwn-sdk-js@0.4.7
  - @enbox/common@0.1.2
  - @enbox/crypto@0.1.3
  - @enbox/dwn-sql-store@0.0.32
  - @enbox/dwn-clients@0.4.12

## 0.1.15

### Patch Changes

- Updated dependencies [[`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1)]:
  - @enbox/dwn-sdk-js@0.4.6
  - @enbox/dwn-clients@0.4.11
  - @enbox/dwn-sql-store@0.0.31

## 0.1.14

### Patch Changes

- Updated dependencies [[`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7), [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37), [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc)]:
  - @enbox/dwn-sdk-js@0.4.5
  - @enbox/dwn-sql-store@0.0.30
  - @enbox/crypto@0.1.2
  - @enbox/dwn-clients@0.4.10
  - @enbox/dids@0.1.2

## 0.1.13

### Patch Changes

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/dwn-sdk-js@0.4.4
  - @enbox/dwn-clients@0.4.9
  - @enbox/dwn-sql-store@0.0.29

## 0.1.12

### Patch Changes

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/dwn-sdk-js@0.4.3
  - @enbox/dwn-clients@0.4.8
  - @enbox/dwn-sql-store@0.0.28

## 0.1.11

### Patch Changes

- Updated dependencies [[`05f5621`](https://github.com/enboxorg/enbox/commit/05f56216adcbdba09ae039238055a4591674ef88)]:
  - @enbox/dwn-sdk-js@0.4.2
  - @enbox/dwn-clients@0.4.7
  - @enbox/dwn-sql-store@0.0.27

## 0.1.10

### Patch Changes

- [#1014](https://github.com/enboxorg/enbox/pull/1014) [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add durable message-store progress positions and replication feed primitives, preserve same-CID index/data-completion transitions, fail fast on pre-substrate Level/IndexedDB layouts, and remove obsolete DWN record upgrade code.

- [#1035](https://github.com/enboxorg/enbox/pull/1035) [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove legacy sync index, wire, and sparse-tree surfaces now that replication uses durable message feeds and scoped fingerprints.

- [#1017](https://github.com/enboxorg/enbox/pull/1017) [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: wire server subscriptions through the durable message-store log and a wake-only event bus

- [#1005](https://github.com/enboxorg/enbox/pull/1005) [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove Bun fetch stream buffering workarounds and pass data streams through HTTP and storage paths directly.

- Updated dependencies [[`970aa97`](https://github.com/enboxorg/enbox/commit/970aa972013c61d9acc6a077f2f5ec2ae72ebf54), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`211049b`](https://github.com/enboxorg/enbox/commit/211049bd7727c80b701e8d6be243a5c464b8bc81), [`5c1e8dc`](https://github.com/enboxorg/enbox/commit/5c1e8dc6bdfee56dce59d9aa963e74c7b4e7ce77), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`e781263`](https://github.com/enboxorg/enbox/commit/e78126309fc09e20be025ac2bf793632234a58f3), [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7), [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`94b6879`](https://github.com/enboxorg/enbox/commit/94b6879b1817afe0d0069473a90087f03fa935a1), [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801), [`d24b8da`](https://github.com/enboxorg/enbox/commit/d24b8dadc4e51c9f5a3b2ff90eb3279a8b6fd0ef), [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`a2bfa0d`](https://github.com/enboxorg/enbox/commit/a2bfa0dafff6a60d3b0343fcade2c6e4d7d871cf), [`f90c4b8`](https://github.com/enboxorg/enbox/commit/f90c4b8a77007337b9ec7711c14885759efab383), [`4129d17`](https://github.com/enboxorg/enbox/commit/4129d1712503ad67010630f729ef37d4ea8fc27b)]:
  - @enbox/dwn-sdk-js@0.4.1
  - @enbox/dwn-sql-store@0.0.26
  - @enbox/dwn-clients@0.4.6

## 0.1.9

### Patch Changes

- [#1002](https://github.com/enboxorg/enbox/pull/1002) [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Route sync push through remote replicated admission and use `ReplicationApplyResult` as the source of truth for push success, dependency fetching, retry, and terminal dead-letter classification.

  Remote DWNs must run a server version exposing `dwn.applyReplicatedMessage` before publishing this agent package.

- [#1001](https://github.com/enboxorg/enbox/pull/1001) [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Route sync pulls through structured replicated-message admission and remove the old closure-repair compensation layer.

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/dwn-sdk-js@0.4.0
  - @enbox/dwn-clients@0.4.5
  - @enbox/dwn-sql-store@0.0.25

## 0.1.8

### Patch Changes

- Updated dependencies [[`5908941`](https://github.com/enboxorg/enbox/commit/590894124552537f9088638b7a3527d4f7f3fda9)]:
  - @enbox/dwn-sdk-js@0.3.9
  - @enbox/dwn-clients@0.4.4
  - @enbox/dwn-sql-store@0.0.24

## 0.1.7

### Patch Changes

- Updated dependencies [[`22dffaa`](https://github.com/enboxorg/enbox/commit/22dffaa13cceb18935a20508fb131f5bb83993dd), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`1a9ba9d`](https://github.com/enboxorg/enbox/commit/1a9ba9db3aa09e7dd73e22e6f555c63eba978fb1), [`923b14f`](https://github.com/enboxorg/enbox/commit/923b14ffc986a7c98ee11a73d979d5d869579881), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`650f630`](https://github.com/enboxorg/enbox/commit/650f6306d42b6aaece08a811c437a59f4eb896b3), [`c801dc7`](https://github.com/enboxorg/enbox/commit/c801dc7045a109f210a1a6d7306f3e215bca9db7), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`67947ca`](https://github.com/enboxorg/enbox/commit/67947ca12d3e5e1343f3ade8dd8c6e261ad41ac3), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3)]:
  - @enbox/dwn-sdk-js@0.3.8
  - @enbox/dwn-clients@0.4.3
  - @enbox/dwn-sql-store@0.0.23

## 0.1.6

### Patch Changes

- Updated dependencies [[`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02)]:
  - @enbox/dwn-sdk-js@0.3.7
  - @enbox/dwn-sql-store@0.0.22
  - @enbox/dwn-clients@0.4.2

## 0.1.5

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
  - @enbox/dwn-clients@0.4.1
  - @enbox/dwn-sdk-js@0.3.6
  - @enbox/crypto@0.1.1
  - @enbox/dwn-sql-store@0.0.21

## 0.1.4

### Patch Changes

- Updated dependencies [[`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999)]:
  - @enbox/dwn-clients@0.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0)]:
  - @enbox/dwn-sdk-js@0.3.5
  - @enbox/dwn-clients@0.3.3
  - @enbox/dwn-sql-store@0.0.20

## 0.1.2

### Patch Changes

- Updated dependencies [[`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d)]:
  - @enbox/dwn-sdk-js@0.3.4
  - @enbox/dwn-sql-store@0.0.19
  - @enbox/dwn-clients@0.3.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/dwn-sdk-js@0.3.3
  - @enbox/dwn-clients@0.3.1
  - @enbox/dwn-sql-store@0.0.18

## 0.1.0

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

### Patch Changes

- Updated dependencies [[`f7b4c79`](https://github.com/enboxorg/enbox/commit/f7b4c79f5a11a4d3de7836bb1ee56e47c90faf3b)]:
  - @enbox/dwn-clients@0.3.0

## 0.0.16

### Patch Changes

- [#792](https://github.com/enboxorg/enbox/pull/792) [`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: prevent empty messageCid in ProgressToken across EventLog and sync engine

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/dwn-sdk-js@0.3.2
  - @enbox/dwn-clients@0.2.6
  - @enbox/dwn-sql-store@0.0.17

## 0.0.15

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
  - @enbox/dwn-sql-store@0.0.16

## 0.0.14

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/dwn-sdk-js@0.3.0
  - @enbox/dwn-clients@0.2.4
  - @enbox/dwn-sql-store@0.0.15

## 0.0.13

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2
  - @enbox/dwn-clients@0.2.3
  - @enbox/dwn-sql-store@0.0.14

## 0.0.12

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1
  - @enbox/dwn-clients@0.2.2
  - @enbox/dwn-sql-store@0.0.13

## 0.0.11

### Patch Changes

- [#721](https://github.com/enboxorg/enbox/pull/721) [`fc923cb`](https://github.com/enboxorg/enbox/commit/fc923cb6a1f6d8e56f616a69d3e61345898d2cf9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(dwn-server): include CORS headers on per-IP rate-limit 429 responses so browsers can read the error instead of treating it as a CORS failure

  fix(agent): throttle sync engine remote requests to prevent rate-limit bursts — tree walk is now gated by a semaphore (max 4 concurrent remote requests) and pull concurrency reduced from 10 to 4

- Updated dependencies [[`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7)]:
  - @enbox/dwn-clients@0.2.1

## 0.0.10

### Patch Changes

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

- Updated dependencies [[`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531)]:
  - @enbox/dwn-clients@0.2.0
  - @enbox/common@0.1.0
  - @enbox/crypto@0.1.0
  - @enbox/dwn-sdk-js@0.2.0
  - @enbox/dids@0.1.0
  - @enbox/dwn-sql-store@0.0.12

## 0.0.9

### Patch Changes

- [#642](https://github.com/enboxorg/enbox/pull/642) [`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde) Thanks [@LiranCohen](https://github.com/LiranCohen)! - refactor: rename Web5-prefixed symbols in common and dwn-server packages

  - `@enbox/common`: `Web5LogLevel` -> `LogLevel`, `Web5LoggerInterface` -> `LoggerInterface`, `Web5Logger` -> `EnboxLogger`, `window.web5logger` -> `window.enboxLogger`
  - `@enbox/dwn-server`: `Web5ConnectServer` -> `ConnectServer`, `Web5ConnectRequest` -> `ConnectRequest`, `Web5ConnectResponse` -> `ConnectResponse`, `SetWeb5ConnectRequestResult` -> `SetConnectRequestResult`
  - Moved `src/web5-connect/` -> `src/connect/` and `tests/web5-connect/` -> `tests/connect/`
  - Deprecated aliases preserved for backward compatibility

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
  - @enbox/dwn-sql-store@0.0.11

## 0.0.8

### Patch Changes

- Updated dependencies [[`7a68c55`](https://github.com/enboxorg/enbox/commit/7a68c5509da7d01700240b630ac529cbf94a629a)]:
  - @enbox/dwn-clients@0.0.9

## 0.0.7

### Patch Changes

- [#541](https://github.com/enboxorg/enbox/pull/541) [`f484270`](https://github.com/enboxorg/enbox/commit/f4842708cbf378ae854105487fa73e880aba806a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Allow passing RegistrationManager and OpenAuthHandler via DwnServerOptions when using a pre-built DWN instance. This enables registration endpoints and open-auth flow for consumers like dwn-relay that construct their own DWN with custom store wrappers. Also exports RegistrationManager and OpenAuthHandler from the package index.

## 0.0.6

### Patch Changes

- [#539](https://github.com/enboxorg/enbox/pull/539) [`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish unpublished fixes across packages

  - `@enbox/common`: `open()` in KeyValueStore interface
  - `@enbox/dids`: `DidResolverCacheMemory`, resolver lifecycle management
  - `@enbox/dwn-sdk-js`: `DidResolverCacheMemory` default in `Dwn.create()` (fixes "Database is not open" in containers)
  - `@enbox/dwn-clients`: `DwnServerInfoCacheMemory`
  - `@enbox/dwn-server`: Actor delivery, noop resolver cache, registration gate fix

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/common@0.0.6
  - @enbox/dids@0.0.8
  - @enbox/dwn-sdk-js@0.1.1
  - @enbox/dwn-clients@0.0.8
  - @enbox/crypto@0.0.7
  - @enbox/dwn-sql-store@0.0.10

This package is a fork of the official DWN Server package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/dwn-server](https://github.com/decentralized-identity/dwn-server)

All changes, releases, and updates are tracked in the upstream repository's changelog.
