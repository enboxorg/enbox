# @enbox/agent

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
