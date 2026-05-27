# @enbox/browser

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
