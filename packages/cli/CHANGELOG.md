# @enbox/cli

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
