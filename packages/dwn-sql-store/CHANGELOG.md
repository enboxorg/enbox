# @enbox/dwn-sql-store

## 0.0.29

### Patch Changes

- Updated dependencies [[`25fd7d4`](https://github.com/enboxorg/enbox/commit/25fd7d433055809f4d96543807f0669ab036383f)]:
  - @enbox/dwn-sdk-js@0.4.4

## 0.0.28

### Patch Changes

- Updated dependencies [[`6bd4199`](https://github.com/enboxorg/enbox/commit/6bd419937c06ff1edf27c148896157e7310631d1)]:
  - @enbox/dwn-sdk-js@0.4.3

## 0.0.27

### Patch Changes

- Updated dependencies [[`05f5621`](https://github.com/enboxorg/enbox/commit/05f56216adcbdba09ae039238055a4591674ef88)]:
  - @enbox/dwn-sdk-js@0.4.2

## 0.0.26

### Patch Changes

- [#1014](https://github.com/enboxorg/enbox/pull/1014) [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add durable message-store progress positions and replication feed primitives, preserve same-CID index/data-completion transitions, fail fast on pre-substrate Level/IndexedDB layouts, and remove obsolete DWN record upgrade code.

- [#1034](https://github.com/enboxorg/enbox/pull/1034) [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - chore: remove same-CID data completion from replication feeds

- [#1035](https://github.com/enboxorg/enbox/pull/1035) [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove legacy sync index, wire, and sparse-tree surfaces now that replication uses durable message feeds and scoped fingerprints.

- [#1007](https://github.com/enboxorg/enbox/pull/1007) [`94b6879`](https://github.com/enboxorg/enbox/commit/94b6879b1817afe0d0069473a90087f03fa935a1) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: always use the S3 Upload helper for streamed object writes.

- [#1016](https://github.com/enboxorg/enbox/pull/1016) [`d24b8da`](https://github.com/enboxorg/enbox/commit/d24b8dadc4e51c9f5a3b2ff90eb3279a8b6fd0ef) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add SQL-backed durable replication log state

- [#1005](https://github.com/enboxorg/enbox/pull/1005) [`9b51592`](https://github.com/enboxorg/enbox/commit/9b51592a00c9e5cec0d8f01bb7b41168ffee3549) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Remove Bun fetch stream buffering workarounds and pass data streams through HTTP and storage paths directly.

- Updated dependencies [[`970aa97`](https://github.com/enboxorg/enbox/commit/970aa972013c61d9acc6a077f2f5ec2ae72ebf54), [`18bf512`](https://github.com/enboxorg/enbox/commit/18bf51241aaad1628255a2c56e28ed5f7450a069), [`211049b`](https://github.com/enboxorg/enbox/commit/211049bd7727c80b701e8d6be243a5c464b8bc81), [`5c1e8dc`](https://github.com/enboxorg/enbox/commit/5c1e8dc6bdfee56dce59d9aa963e74c7b4e7ce77), [`44941d3`](https://github.com/enboxorg/enbox/commit/44941d381f784aa6c22430c0ab6ee57c0ac22670), [`e781263`](https://github.com/enboxorg/enbox/commit/e78126309fc09e20be025ac2bf793632234a58f3), [`05c3203`](https://github.com/enboxorg/enbox/commit/05c3203e5e1cec054754200388e8470785d356a7), [`6a8907d`](https://github.com/enboxorg/enbox/commit/6a8907de94386b714a96ac9409af26dec974cb87), [`25821ed`](https://github.com/enboxorg/enbox/commit/25821eda3a551cc9b2f6605e2716a9705ebf3f63), [`543b834`](https://github.com/enboxorg/enbox/commit/543b8340b8ef8914d52bc79fe8dbe0231e44d801), [`028dd78`](https://github.com/enboxorg/enbox/commit/028dd78442a2217044595fdd7253982af92a1e57), [`a2bfa0d`](https://github.com/enboxorg/enbox/commit/a2bfa0dafff6a60d3b0343fcade2c6e4d7d871cf), [`f90c4b8`](https://github.com/enboxorg/enbox/commit/f90c4b8a77007337b9ec7711c14885759efab383)]:
  - @enbox/dwn-sdk-js@0.4.1

## 0.0.25

### Patch Changes

- Updated dependencies [[`fee3aa0`](https://github.com/enboxorg/enbox/commit/fee3aa0d7862380707fbd3fbe6c8bd85090543b5), [`7c0f246`](https://github.com/enboxorg/enbox/commit/7c0f2462dc390683943d0266be5696ef1da1dbbd), [`8a5b999`](https://github.com/enboxorg/enbox/commit/8a5b999b75a49867b9460fa9eec83667a9953361)]:
  - @enbox/dwn-sdk-js@0.4.0

## 0.0.24

### Patch Changes

- Updated dependencies [[`5908941`](https://github.com/enboxorg/enbox/commit/590894124552537f9088638b7a3527d4f7f3fda9)]:
  - @enbox/dwn-sdk-js@0.3.9

## 0.0.23

### Patch Changes

- Updated dependencies [[`22dffaa`](https://github.com/enboxorg/enbox/commit/22dffaa13cceb18935a20508fb131f5bb83993dd), [`e0badc8`](https://github.com/enboxorg/enbox/commit/e0badc848e26b23e45fbdf79b53cb49bbf0afcc2), [`1a9ba9d`](https://github.com/enboxorg/enbox/commit/1a9ba9db3aa09e7dd73e22e6f555c63eba978fb1), [`923b14f`](https://github.com/enboxorg/enbox/commit/923b14ffc986a7c98ee11a73d979d5d869579881), [`151ab89`](https://github.com/enboxorg/enbox/commit/151ab894a7a2f18a7805a6b984b137dcef009e19), [`650f630`](https://github.com/enboxorg/enbox/commit/650f6306d42b6aaece08a811c437a59f4eb896b3), [`c801dc7`](https://github.com/enboxorg/enbox/commit/c801dc7045a109f210a1a6d7306f3e215bca9db7), [`eea8c4a`](https://github.com/enboxorg/enbox/commit/eea8c4a10d41fd034773c2d543d1c400cc6d2926), [`2910f50`](https://github.com/enboxorg/enbox/commit/2910f503f62b6a0d1fda09666defad44475fd97c), [`67947ca`](https://github.com/enboxorg/enbox/commit/67947ca12d3e5e1343f3ade8dd8c6e261ad41ac3), [`d89d29e`](https://github.com/enboxorg/enbox/commit/d89d29ec27de665afe6a12619d3aa3ae73be48d3)]:
  - @enbox/dwn-sdk-js@0.3.8

## 0.0.22

### Patch Changes

- [#950](https://github.com/enboxorg/enbox/pull/950) [`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Handle duplicate large `RecordsWrite` delivery idempotently in SQL-backed DWNs.

  Exact duplicate writes now return `409 Conflict` before reprocessing large data streams, while SQL data and block stores tolerate overlapping duplicate inserts for the same content-addressed data.

- Updated dependencies [[`3dafab2`](https://github.com/enboxorg/enbox/commit/3dafab2cf0c7ba2880c6446143df3e30929dac02)]:
  - @enbox/dwn-sdk-js@0.3.7

## 0.0.21

### Patch Changes

- Updated dependencies [[`03899ca`](https://github.com/enboxorg/enbox/commit/03899ca7d20ad48b874f7e6253381f19cd7c3480)]:
  - @enbox/dwn-sdk-js@0.3.6

## 0.0.20

### Patch Changes

- Updated dependencies [[`75c7d00`](https://github.com/enboxorg/enbox/commit/75c7d00bb37aac5e1b1286cfebfec2c8772678f0)]:
  - @enbox/dwn-sdk-js@0.3.5

## 0.0.19

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

- Updated dependencies [[`578362d`](https://github.com/enboxorg/enbox/commit/578362d85a18ab1a3ea806d305edfc74196a1f0d)]:
  - @enbox/dwn-sdk-js@0.3.4

## 0.0.18

### Patch Changes

- Updated dependencies [[`2b89675`](https://github.com/enboxorg/enbox/commit/2b896756caf48c627ad7a48ca960dd8730fb8c1e)]:
  - @enbox/dwn-sdk-js@0.3.3

## 0.0.17

### Patch Changes

- Updated dependencies [[`f268675`](https://github.com/enboxorg/enbox/commit/f268675af32dc383795c94841d163e25f881186e)]:
  - @enbox/dwn-sdk-js@0.3.2

## 0.0.16

### Patch Changes

- Updated dependencies [[`5818860`](https://github.com/enboxorg/enbox/commit/5818860e2bca5201ff368d4748393efb1544d7a2)]:
  - @enbox/dwn-sdk-js@0.3.1

## 0.0.15

### Patch Changes

- Updated dependencies [[`802a7a9`](https://github.com/enboxorg/enbox/commit/802a7a9a1e402d4800d1c2c8176b7e5bdce36b95)]:
  - @enbox/dwn-sdk-js@0.3.0

## 0.0.14

### Patch Changes

- Updated dependencies [[`0a17914`](https://github.com/enboxorg/enbox/commit/0a17914b84e030ccdfbc44f2d9edd8e4730b46e3)]:
  - @enbox/dwn-sdk-js@0.2.2

## 0.0.13

### Patch Changes

- Updated dependencies [[`8e262f1`](https://github.com/enboxorg/enbox/commit/8e262f18b109a0864adf2b48b155b498c7cac373)]:
  - @enbox/dwn-sdk-js@0.2.1

## 0.0.12

### Patch Changes

- Updated dependencies [[`af0145e`](https://github.com/enboxorg/enbox/commit/af0145e5084ad32105584d9e5e6a131b188ca531)]:
  - @enbox/dwn-sdk-js@0.2.0

## 0.0.11

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.1.2

## 0.0.10

### Patch Changes

- Updated dependencies [[`4c74a79`](https://github.com/enboxorg/enbox/commit/4c74a794ca9b05fd063371661c0ac45867c6daf2)]:
  - @enbox/dwn-sdk-js@0.1.1

## 0.0.9

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

## 0.0.8

### Patch Changes

- [`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: provider-auth-v0 tenant registration, immutable records, content-addressed data stores, and admin dashboard

- Updated dependencies [[`255ea66`](https://github.com/enboxorg/enbox/commit/255ea668007d728a59899b06f1897b0b933e6bf3)]:
  - @enbox/dwn-sdk-js@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [[`bb0bfa3`](https://github.com/enboxorg/enbox/commit/bb0bfa31917d296968d3e6f2a41daa9ce5d603b1)]:
  - @enbox/dwn-sdk-js@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.0.6

## 0.0.5

### Patch Changes

- Updated dependencies []:
  - @enbox/dwn-sdk-js@0.0.5

## 0.0.4

### Patch Changes

- [#155](https://github.com/enboxorg/enbox/pull/155) [`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: publish all packages so exported symbols match cross-package imports

  The agent package ships prototyping code that imports symbols (AesKw,
  Secp256r1, Hkdf, etc.) from @enbox/crypto and other packages. These
  symbols exist in the source but were not in the published versions.
  Bumping all packages ensures the published dist matches the current source.

- Updated dependencies [[`b25be29`](https://github.com/enboxorg/enbox/commit/b25be292c22be509c28a40998ca1457ac7d6b5e7)]:
  - @enbox/dwn-sdk-js@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [[`8042e15`](https://github.com/enboxorg/enbox/commit/8042e1576c71cc02c4abd2aa35f9d7dc635346ca)]:
  - @enbox/dwn-sdk-js@0.0.3

This package is a fork of the official DWN SQL Store package. For the complete changelog and version history, please refer to the upstream repository:

**Upstream Repository:** [decentralized-identity/dwn-sql-store](https://github.com/decentralized-identity/dwn-sql-store)

All changes, releases, and updates are tracked in the upstream repository's changelog.
