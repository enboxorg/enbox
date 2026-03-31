---
"@enbox/agent": patch
---

fix: exempt built-in permissions protocol from sync closure validation

The permissions protocol (`https://identity.foundation/dwn/permissions`)
is a core protocol handled natively by every DWN — it never has a
`ProtocolsConfigure` message. The closure resolver was requiring one for
permission grant records, causing `ClosureProtocolMetadataMissing`
failures and cascading `ProtocolAuthorizationProtocolNotFound` errors
during delegated connect flows.
