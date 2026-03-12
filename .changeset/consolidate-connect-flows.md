---
"@enbox/agent": major
"@enbox/auth": minor
---

refactor: move WalletConnect client from agent to auth, deduplicate connect flow helpers

BREAKING CHANGE (@enbox/agent): `WalletConnect` namespace (initClient, createPermissionRequestForProtocol, types) is no longer exported from `@enbox/agent`. Import from `@enbox/auth` instead.

- Move `WalletConnect` client to `@enbox/auth/wallet-connect-client` (zero coupling to agent internals)
- Add `close()` to `SyncEngine` interface and `AgentSyncApi`, eliminating `as any` casts in auth
- Deduplicate `connectedDid/delegateDid` derivation via shared `resolveIdentityDids()` helper
- Restructure auth `flows/` directory into `connect/` with shared `lifecycle.ts` helpers
