# @enbox/cli

## 0.1.7

### Patch Changes

- [#1237](https://github.com/enboxorg/enbox/pull/1237) [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4) Thanks [@poindex-bot](https://github.com/poindex-bot)! - feat: unify the connect handshake behind a single kernel. New `@enbox/connect` package: one JWE envelope (ECDH-ES/X25519 + XC20P, PIN folded into the KDF so it never transits), one request/response schema, JWT signing, wallet URI, relay transport, and `ConnectClient`/`ConnectProvider` state machines. The agent gains `executeConnectApproval` — the single transport-agnostic wallet-side approval ceremony — replacing `EnboxConnectProtocol` (deleted, including its hand-rolled compact-JWE serializer). Auth's relay client and the browser popup flow now ride the kernel; the browser P-256 ECDH + AES-GCM postMessage stack is deleted and both popup directions are now signed and encrypted with pinned-origin checks throughout.

- Updated dependencies [[`998232d`](https://github.com/enboxorg/enbox/commit/998232da2c4124b18bd014ffa6494156fd31cad7), [`1a71f03`](https://github.com/enboxorg/enbox/commit/1a71f03093598f604445910ad1df1fb64e5685f4), [`2501b96`](https://github.com/enboxorg/enbox/commit/2501b96d643124baebe7632ee369e893789c938b)]:
  - @enbox/agent@0.8.16
  - @enbox/connect@0.1.1
  - @enbox/auth@0.6.62
  - @enbox/api@0.6.54

## 0.1.6

### Patch Changes

- Updated dependencies [[`378f3d4`](https://github.com/enboxorg/enbox/commit/378f3d4b07a011e9f56852cfc0a4e9da8cd13bd4), [`d7f0a87`](https://github.com/enboxorg/enbox/commit/d7f0a87b211c7eb3fb2ee1e048a51b2deab2305a), [`49449ad`](https://github.com/enboxorg/enbox/commit/49449ade45463baa3ac2190c5455b7dba1f1e39b), [`d1bc6e3`](https://github.com/enboxorg/enbox/commit/d1bc6e3be5ae95792c7378aff53824e67fbb952a), [`c12b323`](https://github.com/enboxorg/enbox/commit/c12b3239ce03bf29bcd2b3a37c8c650c7b29ace1), [`1e316ee`](https://github.com/enboxorg/enbox/commit/1e316eeca6a29453364cbc931c9407b36a1282f9), [`55581c7`](https://github.com/enboxorg/enbox/commit/55581c71dc1ea7bc8715f92c56ba71692f7bc33e), [`cb7b51c`](https://github.com/enboxorg/enbox/commit/cb7b51c1ad3576fc8851e4ec41e55e46e5cb187f), [`acd3d4e`](https://github.com/enboxorg/enbox/commit/acd3d4eb54e32cee199759c06db0cbe699780d41), [`5ac59ff`](https://github.com/enboxorg/enbox/commit/5ac59fff9e1e2804def54b6b63cf49b75199b57c)]:
  - @enbox/agent@0.8.15
  - @enbox/auth@0.6.61
  - @enbox/api@0.6.53

## 0.1.5

### Patch Changes

- Updated dependencies [[`d7467fe`](https://github.com/enboxorg/enbox/commit/d7467fef30d809e25bd0c840338301b9b9d912e0)]:
  - @enbox/agent@0.8.14
  - @enbox/auth@0.6.60
  - @enbox/api@0.6.52

## 0.1.4

### Patch Changes

- Updated dependencies [[`96ea6cb`](https://github.com/enboxorg/enbox/commit/96ea6cbda08a4bb6540d8a4e2664278f82d6fba8), [`6b5b978`](https://github.com/enboxorg/enbox/commit/6b5b9786ee931f8d80d84e5f2865166c39568eb6)]:
  - @enbox/auth@0.6.59
  - @enbox/api@0.6.51
  - @enbox/agent@0.8.13

## 0.1.3

### Patch Changes

- [#1183](https://github.com/enboxorg/enbox/pull/1183) [`0dd7dff`](https://github.com/enboxorg/enbox/commit/0dd7dffff90360b0d0e6d82574b3b9a33a872ab0) Thanks [@LiranCohen](https://github.com/LiranCohen)! - fix: validate connect grants (grantee, scope subset) in the shared connect path for every transport

  The grantee-matches-delegate and granted-scopes-subset checks lived in the CLI handler only, so browser popup and direct relay connects imported whatever a wallet returned. The validation now runs in AuthManager's handler flow and in walletConnect, and @enbox/cli drops its private copy.

- Updated dependencies [[`60a9abb`](https://github.com/enboxorg/enbox/commit/60a9abb62e3c16368793f17b9ee0e735938ae804), [`0dd7dff`](https://github.com/enboxorg/enbox/commit/0dd7dffff90360b0d0e6d82574b3b9a33a872ab0)]:
  - @enbox/agent@0.8.12
  - @enbox/auth@0.6.58
  - @enbox/api@0.6.50

## 0.1.2

### Patch Changes

- Updated dependencies [[`e4f3a08`](https://github.com/enboxorg/enbox/commit/e4f3a0878b59dddcfed83512969c5dac68fd2979)]:
  - @enbox/agent@0.8.11
  - @enbox/auth@0.6.57
  - @enbox/api@0.6.49

## 0.1.1

### Patch Changes

- [#1159](https://github.com/enboxorg/enbox/pull/1159) [`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: add a CLI relay connect handler package

- [#1175](https://github.com/enboxorg/enbox/pull/1175) [`8a5f43e`](https://github.com/enboxorg/enbox/commit/8a5f43ea4f594bdedc6360c1aab473c177f22ea5) Thanks [@LiranCohen](https://github.com/LiranCohen)! - feat: resolve the connect relay from the wallet's well-known document and default CLI sessions to a 30-day requested TTL

- [#1173](https://github.com/enboxorg/enbox/pull/1173) [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff) Thanks [@LiranCohen](https://github.com/LiranCohen)! - Add pre-supplied delegate DID support to relay connect flows so CLI clients can keep delegate private keys local while wallets grant to the requested DID.

- Updated dependencies [[`617edf4`](https://github.com/enboxorg/enbox/commit/617edf4168bd454fdd76ec0aba243f28b4dc9331), [`6914270`](https://github.com/enboxorg/enbox/commit/69142706fa47c74304d357cc7865112dc0e46bff), [`9211810`](https://github.com/enboxorg/enbox/commit/921181002eacc4fdec2264c1334cc7e91b3b0781)]:
  - @enbox/agent@0.8.10
  - @enbox/auth@0.6.56
  - @enbox/api@0.6.48
