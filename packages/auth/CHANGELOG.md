# @enbox/auth

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
