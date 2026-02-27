# @enbox/auth

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
