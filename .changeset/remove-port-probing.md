---
"@enbox/agent": minor
"@enbox/auth": minor
---

Remove port probing and add remote DWN mode

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
