# @enbox/dwn-clients

## 0.4.21

### Patch Changes

- [#1362](https://github.com/enboxorg/enbox/pull/1362) [`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: lossless subscription-decrypt backpressure with acks gated on consumer completion

  The decrypting subscription wrapper returns each event's completion promise — now covering decryption AND the consumer's own (possibly async) processing — and the WebSocket client acks each event, and advances its reconnect cursor, only after that completion resolves, in delivery order. If more than 256 events queue behind in-flight decryption the wrapper terminates losslessly: the overflowing and all later events reject with the new `SubscriptionHandlerTerminalError`, which the WebSocket transport honors by closing the tracked subscription and withholding their acks and cursor advancement, while the consumer receives a synthetic `SubscriptionDecryptBackpressureExceeded` error carrying the last successfully delivered cursor — resubscribing from it replays every dropped event. `SubscriptionListener` and `DwnSubscriptionHandler` now explicitly permit `void | Promise<void>`, and every handler invocation — event delivery and transport lifecycle notifications alike — is normalized through a promise chain: a synchronous throw becomes an observed rejection instead of escaping the socket dispatch or skipping other subscriptions' notifications. `@enbox/browser` also re-exports `AudienceDecryptError`, `AudienceDecryptFailureCause`, and `AudienceKeyDeliveryOutcome` so browser-only apps can classify decrypt failures and delivery outcomes without importing `@enbox/api` directly.

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

- Updated dependencies [[`33a4dea`](https://github.com/enboxorg/enbox/commit/33a4deab2e15b46d545154cbca2836ef0af0f7ca)]:
  - @enbox/dwn-sdk-js@0.4.14

## 0.4.20

### Patch Changes

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

- Updated dependencies [[`4430d0d`](https://github.com/enboxorg/enbox/commit/4430d0df16b34215f3db6965960e07a67f6d8441), [`6151a52`](https://github.com/enboxorg/enbox/commit/6151a5249e4cee07673cff0290cdbcb03d80db86), [`a4fb419`](https://github.com/enboxorg/enbox/commit/a4fb419d9475b9d21e518028411ef149c47cbdc9), [`451fd02`](https://github.com/enboxorg/enbox/commit/451fd024b25158be1290d589e2a13a199bb1b58c), [`eabdec5`](https://github.com/enboxorg/enbox/commit/eabdec5c9efe2580ec3412edd07f8f2f0a3e5b67), [`28407c2`](https://github.com/enboxorg/enbox/commit/28407c2fe21b5dab27a42c1ccef6786be6b8c211), [`1e8c7bb`](https://github.com/enboxorg/enbox/commit/1e8c7bb3e6b2df88ca3a6630c4bbdf408bedaefb), [`e22ac1d`](https://github.com/enboxorg/enbox/commit/e22ac1d30c09f7bce3bc4e634a4d5c7cdf95603e), [`12ce706`](https://github.com/enboxorg/enbox/commit/12ce706f9412d8405f130c2fd56c3c8f898db8c1), [`a3c42d7`](https://github.com/enboxorg/enbox/commit/a3c42d777b9bb23448c3b8fd58f26c100ee42dd0)]:
  - @enbox/dwn-sdk-js@0.4.13
  - @enbox/crypto@0.1.7
  - @enbox/common@0.1.4

## 0.4.19

### Patch Changes

- [#1280](https://github.com/enboxorg/enbox/pull/1280) [`3a7325a`](https://github.com/enboxorg/enbox/commit/3a7325ad994b585b7fa0b98e2c8eed78d9b38131) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix(replication): move negotiated HTTP RPC envelopes into a streaming request body and stop replaying dependencies the remote has already acknowledged

  HTTP clients now negotiate `body-v1` through the server's `/info` response. Supporting peers send the JSON-RPC envelope and optional raw record data in one length-prefixed, streaming body, avoiding proxy header limits without buffering or base64-expanding large attachments. Older servers continue to receive the legacy `dwn-request` header format.

  The agent now treats `Applied`, `Duplicate`, and `Superseded` dependency results as acknowledgements. If a root continues to report only acknowledged dependencies as missing, it is handed to delayed reconciliation instead of consuming the admission pass budget and immediate retry ladder.

## 0.4.18

### Patch Changes

- Updated dependencies [[`1341db0`](https://github.com/enboxorg/enbox/commit/1341db0976494bd0ec572fc61de3e480dfbbd081)]:
  - @enbox/crypto@0.1.6
  - @enbox/dwn-sdk-js@0.4.12

## 0.4.17

### Patch Changes

- Updated dependencies [[`48e3db8`](https://github.com/enboxorg/enbox/commit/48e3db8764e67e8e719cb0557fa7bf739768d9ca)]:
  - @enbox/dwn-sdk-js@0.4.11

## 0.4.16

### Patch Changes

- [#1233](https://github.com/enboxorg/enbox/pull/1233) [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: accept `EncryptionControl` dependency refs in replication apply results (previously rejected as malformed, breaking sync recovery of encryption-control dependencies) and remove dead legacy encryption paths: the unproducible `EncryptionProtocol` dependency-ref chain, raw-private-key decrypt/derive overloads superseded by KMS callbacks, the legacy role-epoch schema branch, unused `Delivery`/`GrantKey` precompiled validators, the test-only participant-detection cluster, and orphaned crypto primitives (`EciesSecp256k1`, `ConcatKdf`, plain `XChaCha20`, `AesCtrAlgorithm`, JOSE type duplicates).

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/crypto@0.1.5
  - @enbox/dwn-sdk-js@0.4.10

## 0.4.15

### Patch Changes

- [#1228](https://github.com/enboxorg/enbox/pull/1228) [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Harden local-node ejection with authenticated stable drains, safe outage fallback, persisted consent, native token discovery, and durable local storage.

- [#1208](https://github.com/enboxorg/enbox/pull/1208) [`98f4348`](https://github.com/enboxorg/enbox/commit/98f4348bfbfb7d5ddbc91787f4187958998ba011) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: add the local-node server profile skeleton

- [#1217](https://github.com/enboxorg/enbox/pull/1217) [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add browser local-node probing, pairing persistence, and token-authenticated DWN transports

- [#1212](https://github.com/enboxorg/enbox/pull/1212) [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41) Thanks [@poindex-bot](https://github.com/poindex-bot)! - fix: resolve remaining SonarCloud reliability issues (S7773/S7781/S7758/S6853/S8786)

  Behavior-preserving reliability hardening across packages:

  - Replace global `parseInt`/`isNaN` with `Number.parseInt`/`Number.isNaN` (S7773).
  - Replace `String#replace(/…/g)` and `split().join()` with `String#replaceAll` (S7781).
  - Prefer `String.fromCodePoint`/`String#codePointAt` in byte-range encoders (S7758).
  - Associate admin-UI form labels with their inputs via `for`/`id` (S6853).
  - Strip trailing slashes in the local-node `/info` handler with a linear loop
    instead of a backtracking-prone regex (S8786).

- Updated dependencies [[`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/common@0.1.3
  - @enbox/dwn-sdk-js@0.4.9
  - @enbox/crypto@0.1.4

## 0.4.14

### Patch Changes

- Updated dependencies [[`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/dwn-sdk-js@0.4.8

## 0.4.13

### Patch Changes

- [#1180](https://github.com/enboxorg/enbox/pull/1180) [`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: release sockets and store handles on shutdown so CLI processes exit

  WebSocket RPC connections are pooled process-wide with heartbeat timers and were never closed, keeping the event loop alive after AuthManager.shutdown() resolved; the agent's DWN stores, DID resolver cache, and vault/secret stores also stayed open, wedging same-dataPath reopens and cross-process writes. Adds WebSocketDwnRpcClient.closeAllConnections() and a close() contract to EnboxRpc, a full EnboxUserAgent.shutdown() lifecycle, and delegates AuthManager.shutdown() to it.

## 0.4.12

### Patch Changes

- [#1156](https://github.com/enboxorg/enbox/pull/1156) [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove the legacy epoch-based role-audience encryption path and pin sealed-audience end-to-end coverage.

- [#1137](https://github.com/enboxorg/enbox/pull/1137) [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: replace direct ms usage with a shared duration parser.

- Updated dependencies [[`7ddb0d6`](https://github.com/enboxorg/enbox/commit/7ddb0d677065483968ef9d80773e3fd81048f4ad), [`37895ff`](https://github.com/enboxorg/enbox/commit/37895ff511258ed48d10660b1f73ce597e818921), [`cda1d31`](https://github.com/enboxorg/enbox/commit/cda1d31b4c8a7df444beadd0271ff50a3482fa00), [`5de6973`](https://github.com/enboxorg/enbox/commit/5de6973f98216a3732800a6ec461520b47171902), [`6660507`](https://github.com/enboxorg/enbox/commit/6660507d9fe4d1157c9afa2f870bd3f54b92c9f6), [`c33b1ae`](https://github.com/enboxorg/enbox/commit/c33b1ae23c152c9f27fb740fd650199acc958ad2), [`042879e`](https://github.com/enboxorg/enbox/commit/042879ea1e05d45b99ab35e23f1ab2f730afa757), [`efa5171`](https://github.com/enboxorg/enbox/commit/efa5171b36aa0f46e957e74506323f9cbd4d8dc7), [`97dced6`](https://github.com/enboxorg/enbox/commit/97dced6b0eb80fccbd71ea5a8a1c250ba40153bb), [`c6feb1c`](https://github.com/enboxorg/enbox/commit/c6feb1c1b80ef2646308c3499476802d12af702e), [`6bb25d3`](https://github.com/enboxorg/enbox/commit/6bb25d3f5cfa8dadbd3ae7cfe36f9c5d24bd554c), [`a9106f1`](https://github.com/enboxorg/enbox/commit/a9106f17c94aee5f236cd5a8e81d93b70da53f58), [`3825320`](https://github.com/enboxorg/enbox/commit/38253204113d8d6110a4f97c8f0bfa2b79f16850), [`23ae738`](https://github.com/enboxorg/enbox/commit/23ae7389a4c14aedf360c5b3b3bbdd8c274ef53a), [`b38dd5e`](https://github.com/enboxorg/enbox/commit/b38dd5ec24129a37e8e2bb17b3173144ac9bb863), [`ed62ddc`](https://github.com/enboxorg/enbox/commit/ed62ddc55aeb364000ef5eda2c0ae9fb16da73cc), [`60f194e`](https://github.com/enboxorg/enbox/commit/60f194ea16cd8938635ee15e648b2c315ae366a7), [`96bc5f5`](https://github.com/enboxorg/enbox/commit/96bc5f5c2d80f0cb543042e3f41f5c2d4156c3d3), [`f0a65e9`](https://github.com/enboxorg/enbox/commit/f0a65e917fe4b694ecb555f7e639607c5f5c41e6), [`c921621`](https://github.com/enboxorg/enbox/commit/c92162135f165c1e06423d72180994b27434bc4c), [`25a0d8c`](https://github.com/enboxorg/enbox/commit/25a0d8ca35157762aad360459bb81800e6e2d688), [`cd08e9a`](https://github.com/enboxorg/enbox/commit/cd08e9a2dfbf060244744d88bfdf5b4b6c6b3852), [`d3e267e`](https://github.com/enboxorg/enbox/commit/d3e267e3ca259432e477715cba1b9c50db5fdb97), [`425cc9d`](https://github.com/enboxorg/enbox/commit/425cc9d6835f0cc75e90050ac23ceac65ebc3f46), [`57c66a3`](https://github.com/enboxorg/enbox/commit/57c66a34079625793c8b26028f29d1eb63b969ef)]:
  - @enbox/dwn-sdk-js@0.4.7
  - @enbox/common@0.1.2
  - @enbox/crypto@0.1.3

## 0.4.11

### Patch Changes

- Updated dependencies [[`f06e984`](https://github.com/enboxorg/enbox/commit/f06e984f0a512fa1e53729e31e186328595af1a1)]:
  - @enbox/dwn-sdk-js@0.4.6

## 0.4.10

### Patch Changes

- [#1077](https://github.com/enboxorg/enbox/pull/1077) [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: implement DWN encryption v1 records, protocol keys, and delegate key delivery

- Updated dependencies [[`03740b9`](https://github.com/enboxorg/enbox/commit/03740b975d39f74337d1f292ba9115dd799ad6e7), [`4863c1a`](https://github.com/enboxorg/enbox/commit/4863c1a17f132d7ffd8a8c2ac46472f8585d7d37), [`e27f4f6`](https://github.com/enboxorg/enbox/commit/e27f4f647189535ffe32a9f6a16c5859afadb3fc)]:
  - @enbox/dwn-sdk-js@0.4.5
  - @enbox/crypto@0.1.2

## 0.4.9

### Patch Changes

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/dwn-sdk-js@0.4.4

## 0.4.8

### Patch Changes

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/dwn-sdk-js@0.4.3

## 0.4.7

### Patch Changes

- Updated dependencies [[`05f5621`](https://github.com/enboxorg/enbox/commit/05f56216adcbdba09ae039238055a4591674ef88)]:
  - @enbox/dwn-sdk-js@0.4.2

## 0.4.6

### Patch Changes

- [#1005](https://github.com/enboxorg/enbox/pull/1005) [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove Bun fetch stream buffering workarounds and pass data streams through HTTP and storage paths directly.

- [#1025](https://github.com/enboxorg/enbox/pull/1025) [`4129d17`](https://github.com/enboxorg/enbox/commit/4129d1712503ad67010630f729ef37d4ea8fc27b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: normalize DWN endpoints for sync links and WebSocket connections

- Updated dependencies [[`970aa97`](https://github.com/enboxorg/enbox/commit/970aa972013c61d9acc6a077f2f5ec2ae72ebf54), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`211049b`](https://github.com/enboxorg/enbox/commit/211049bd7727c80b701e8d6be243a5c464b8bc81), [`5c1e8dc`](https://github.com/enboxorg/enbox/commit/5c1e8dc6bdfee56dce59d9aa963e74c7b4e7ce77), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`e781263`](https://github.com/enboxorg/enbox/commit/e78126309fc09e20be025ac2bf793632234a58f3), [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7), [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`a2bfa0d`](https://github.com/enboxorg/enbox/commit/a2bfa0dafff6a60d3b0343fcade2c6e4d7d871cf), [`f90c4b8`](https://github.com/enboxorg/enbox/commit/f90c4b8a77007337b9ec7711c14885759efab383)]:
  - @enbox/dwn-sdk-js@0.4.1

## 0.4.5

### Patch Changes

- [#1002](https://github.com/enboxorg/enbox/pull/1002) [`3639aa0`](https://github.com/enboxorg/enbox/commit/3639aa0b0de11d4bcfdd5afbe4ab7f3baeb5c93a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Route sync push through remote replicated admission and use `ReplicationApplyResult` as the source of truth for push success, dependency fetching, retry, and terminal dead-letter classification.

  Remote DWNs must run a server version exposing `dwn.applyReplicatedMessage` before publishing this agent package.

- [#1001](https://github.com/enboxorg/enbox/pull/1001) [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Route sync pulls through structured replicated-message admission and remove the old closure-repair compensation layer.

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/dwn-sdk-js@0.4.0

## 0.4.4

### Patch Changes

- Updated dependencies [[`5908941`](https://github.com/enboxorg/enbox/commit/590894124552537f9088638b7a3527d4f7f3fda9)]:
  - @enbox/dwn-sdk-js@0.3.9

## 0.4.3

### Patch Changes

- [#959](https://github.com/enboxorg/enbox/pull/959) [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Close delegated MessagesSubscribe streams when invoked grants become invalid during delivery, surface terminal live-query errors, and keep subscription resume checkpoints monotonic.

- Updated dependencies [[`22dffaa`](https://github.com/enboxorg/enbox/commit/22dffaa13cceb18935a20508fb131f5bb83993dd), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`1a9ba9d`](https://github.com/enboxorg/enbox/commit/1a9ba9db3aa09e7dd73e22e6f555c63eba978fb1), [`923b14f`](https://github.com/enboxorg/enbox/commit/923b14ffc986a7c98ee11a73d979d5d869579881), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`650f630`](https://github.com/enboxorg/enbox/commit/650f6306d42b6aaece08a811c437a59f4eb896b3), [`c801dc7`](https://github.com/enboxorg/enbox/commit/c801dc7045a109f210a1a6d7306f3e215bca9db7), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`67947ca`](https://github.com/enboxorg/enbox/commit/67947ca12d3e5e1343f3ade8dd8c6e261ad41ac3), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3)]:
  - @enbox/dwn-sdk-js@0.3.8

## 0.4.2

### Patch Changes

- Updated dependencies [[`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02)]:
  - @enbox/dwn-sdk-js@0.3.7

## 0.4.1

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
  - @enbox/common@0.1.1
  - @enbox/dwn-sdk-js@0.3.6
  - @enbox/crypto@0.1.1

## 0.4.0

### Minor Changes

- [#914](https://github.com/enboxorg/enbox/pull/914) [`cd3c75e`](https://github.com/enboxorg/enbox/commit/cd3c75eec76fb39ede10def54c74cb7923c57999) Thanks [@LiranCohen](https://github.com/LiranCohen)! - perf(connect): eliminate redundant remote ProtocolsConfigure send and cap per-request budget in the wallet "Authorizing…" hot path

  Two fixes that together remove the dominant tail-latency in `submitConnectResponse`:

  1. **`@enbox/agent` — `prepareProtocol` no longer issues a redundant remote send when the protocol is already installed locally.** The wallet's own `prepareProtocol` (in `@enbox/web-wallet`) runs _before_ `submitConnectResponse` and is the canonical place that fans the protocol out to every owner DWN endpoint in parallel. The agent only needs to verify the protocol is installed locally so it can sign / encrypt grants for it. The "exists locally" branch now performs a single local `ProtocolsQuery` and returns — turning the previous sequential per-endpoint legacy `agent.sendDwnRequest` (which could burn the underlying HTTP client's 4×30 s retry budget on a single unhealthy endpoint, _per protocol_) into a ~10 ms local DB read. The "missing locally" safety-fallback branch now configures the protocol locally via `processDwnRequest` and then fans out to every endpoint in parallel using the existing `mapConcurrentSettled` + `CONNECT_FANOUT_CONCURRENCY` primitive (best-effort — sync delivers any missed copies eventually).

  2. **`@enbox/dwn-clients` — `DwnRpcRequest` now accepts an optional `signal: AbortSignal`, plumbed through `HttpDwnRpcClient.sendDwnRequest` / `fetchWithRetry` via `AbortSignal.any([caller, perAttemptTimeout])`.** Aborting short-circuits the retry loop (`AbortError` is non-retryable). The connect flow uses this with a 10 s per-request budget on every connect-flow `agent.rpc.sendDwnRequest` (configure fan-out + permission grants + revocation grants) so a single unhealthy DWN endpoint can no longer stall the user-visible "Authorizing…" spinner for minutes.

  Test coverage:

  - `packages/agent/tests/connect.spec.ts` — wall-clock parallelism assertion, AbortSignal presence assertion, and a "one endpoint hangs forever" scenario whose end-to-end completes well under the per-request budget.
  - `packages/dwn-clients/tests/http-dwn-rpc-client.spec.ts` — caller signal is plumbed to fetch and abort short-circuits the retry loop on the very first attempt.
  - All existing `connect.spec.ts` assertions for `prepareProtocol` updated to match the new "skip redundant remote send when local" + "parallel fan-out via RPC client when missing locally" shape.

## 0.3.3

### Patch Changes

- Updated dependencies [[`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0)]:
  - @enbox/dwn-sdk-js@0.3.5

## 0.3.2

### Patch Changes

- Updated dependencies [[`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d)]:
  - @enbox/dwn-sdk-js@0.3.4

## 0.3.1

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/dwn-sdk-js@0.3.3

## 0.3.0

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

## 0.2.6

### Patch Changes

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/dwn-sdk-js@0.3.2

## 0.2.5

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

## 0.2.4

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/dwn-sdk-js@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1

## 0.2.1

### Patch Changes

- [#719](https://github.com/enboxorg/enbox/pull/719) [`453a795`](https://github.com/enboxorg/enbox/commit/453a7952c8aa2b8f57289cd5c437a21be34abaa7) Thanks [@csuwildcat](https://github.com/csuwildcat)! - fix(agent): prefer locally-stored BearerDid for signing, avoiding unnecessary DID resolution round-trips that can fail on malformed cached data

  fix(dwn-clients): handle ReadableStream fetch bodies correctly per runtime — buffer to Blob in Bun (workaround for stream upload bugs), set `duplex: 'half'` in browsers and Node as required by the Fetch spec

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
  - @enbox/common@0.1.0
  - @enbox/crypto@0.1.0
  - @enbox/dwn-sdk-js@0.2.0

## 0.1.0

### Minor Changes

- [#628](https://github.com/enboxorg/enbox/pull/628) [`652f5bd`](https://github.com/enboxorg/enbox/commit/652f5bd8f5ac1017405099dee337821a8b731c4b) Thanks [@LiranCohen](https://github.com/LiranCohen)! - BREAKING: Rename Web5-prefixed symbols to Enbox-prefixed across agent and dwn-clients

  - `Web5Agent` → `EnboxAgent`, `Web5UserAgent` → `EnboxUserAgent`, `Web5PlatformAgent` → `EnboxPlatformAgent`
  - `Web5RpcClient` → `EnboxRpcClient`, `Web5Rpc` → `EnboxRpc`, `HttpWeb5RpcClient` → `HttpEnboxRpcClient`, `WebSocketWeb5RpcClient` → `WebSocketEnboxRpcClient`
  - `Web5ConnectAuthRequest` → `EnboxConnectAuthRequest`, `Web5ConnectAuthResponse` → `EnboxConnectAuthResponse`
  - Deprecated aliases preserved for all renamed symbols
  - File renamed: `web5-user-agent.ts` → `enbox-user-agent.ts`
  - All downstream packages updated: @enbox/api, @enbox/auth

### Patch Changes

- Updated dependencies [[`ee033b4`](https://github.com/enboxorg/enbox/commit/ee033b41f7e9f1c3f9bbc1dc4e6448b911deafde), [`5982088`](https://github.com/enboxorg/enbox/commit/5982088c868ec20cce1949afbe042805d412e60d)]:
  - @enbox/common@0.0.7
  - @enbox/crypto@0.0.8
  - @enbox/dwn-sdk-js@0.1.2

## 0.0.9

### Patch Changes

- [#553](https://github.com/enboxorg/enbox/pull/553) [`7a68c55`](https://github.com/enboxorg/enbox/commit/7a68c5509da7d01700240b630ac529cbf94a629a) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: include providerAuth and maxInFlight in getServerInfo response

  `HttpDwnRpcClient.getServerInfo()` explicitly mapped fields from the `/info` JSON response but omitted `providerAuth` and `maxInFlight`, causing provider-auth-v0 registration to silently fall through to the PoW path.

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
  - @enbox/dwn-sdk-js@0.1.1
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
  - @enbox/dwn-sdk-js@0.1.0
  - @enbox/common@0.0.5
  - @enbox/crypto@0.0.6

## 0.0.6

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/common@0.0.4
  - @enbox/crypto@0.0.5
  - @enbox/dwn-sdk-js@0.0.8

## 0.0.5

### Patch Changes

- [#267](https://github.com/enboxorg/enbox/pull/267) [`a111281`](https://github.com/enboxorg/enbox/commit/a111281ad3fb209680073154a95d97d26fc3edf8) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: add `duplex: 'half'` to streaming fetch requests for browser compatibility

  Browsers require `duplex: 'half'` in the `RequestInit` options when the request
  body is a `ReadableStream`. Without it, the sync-push path (which sends record
  data as a raw stream) fails with:
  "The `duplex` member must be specified for a request with a streaming body".

## 0.0.4

### Patch Changes

- [#242](https://github.com/enboxorg/enbox/pull/242) [`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Protocol-first Web5 API surface: `web5.using(protocol)` replaces `web5.dwn`, `TypedWeb5` replaces `TypedDwnApi`, `DwnApi` moved to `@enbox/api/advanced` sub-path. Flat request shapes, `records.create()`/`createFrom()` removed, `Record.update()`/`delete()` return new immutable records, `dateModified` renamed to `timestamp`. Smart `configure()` skips redundant re-installation when definition is unchanged.

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/dwn-sdk-js@0.0.7

## 0.0.3

### Patch Changes

- Updated dependencies [[`af2ba3a`](https://github.com/enboxorg/enbox/commit/af2ba3a7e9d5de44b40a38169e9296427a4f049b)]:
  - @enbox/crypto@0.0.4
  - @enbox/dwn-sdk-js@0.0.6

## 0.0.2

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.0.5
