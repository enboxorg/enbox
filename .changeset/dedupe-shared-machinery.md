---
"@enbox/common": patch
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/api": patch
"@enbox/protocol-codegen": patch
---

refactor: single-source shared machinery and demote permission record wrappers

Consolidates duplicated implementations onto one shared definition each: protocol-structure walking (`walkProtocolRuleSets` in dwn-sdk-js, now used by the SDK and `@enbox/api`), canonical JSON serialization (`canonicalizeJson`/`canonicalJsonStringify` in `@enbox/common`, replacing three locale-dependent copies), temporal `ProtocolsConfigure` lookup (one `queryProtocolConfigure` for the validation-state reader and replication support), encryption-control record matching (the tag shape is now owned by the write side in the agent), and connection-status grant fetching (`fetchConnectionStatus` in `@enbox/auth`, replacing the copy in `Enbox.getConnectionStatus`).

The agent's DWN record stores now share one query/index/cache pipeline with per-store hooks instead of three near-identical `getAllRecords` implementations, and the API's observed views share one listener/close/drain base class.

`PermissionGrant`, `PermissionRequest`, and `PermissionGrantRevocation` (plus their model types) are no longer exported from the `@enbox/api` root; they remain available from `@enbox/api/advanced` alongside the `DwnApi` surface they belong to.
