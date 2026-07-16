---
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/api": patch
---

feat: standardized trigger for DWN endpoint changes on a connected identity

Connected apps no longer need a disconnect/reconnect to notice that a DID's DWN
service endpoints changed. Two layers:

- **Refresh primitive + event.** `AgentDidApi.refreshResolution()` force-evicts a
  cached DID resolution and re-resolves; `SyncEngineLevel.invalidateSyncTargets()`
  drops the memoized endpoint targets; `AgentIdentityApi.refreshDwnEndpoints()`
  composes both. `AuthManager.refreshConnection()` (and `Enbox.refreshConnection()`)
  re-resolves the connected DID and emits a new `connection-endpoints-changed`
  event with the added/removed delta. `setDwnEndpoints()` now also invalidates the
  sync-targets cache.

- **Service-config announcement.** A new published `serviceConfig` DWN protocol
  (owner-write, anyone-read) carries a "poke" record. `setDwnEndpoints()` publishes
  it by default (`announce: false` to opt out; `publishServiceConfig()` to trigger
  standalone). Apps opt in by adding `serviceConfigProtocolRequest()` to their
  connect `protocols` and calling `AuthManager.startServiceConfigWatch()`, which
  subscribes to the announcement (replicated via sync) and calls
  `refreshConnection()` on change. The DID document remains authoritative — the
  record only prompts a fresh resolution.
