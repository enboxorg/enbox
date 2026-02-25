# @enbox/dwn-server

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
