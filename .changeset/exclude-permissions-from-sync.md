---
"@enbox/auth": patch
---

fix: exclude permissions protocol from delegate sync targets

processConnectedGrants was including the DWN permissions protocol
in connectedProtocols because submitConnectResponse creates a
revocation grant scoped to PermissionsProtocol.uri. This caused the
sync engine to register the permissions protocol as a sync target,
which then failed with "No permissions found for MessagesSync".

Permission records are already included in each protocol's sync stream
via PermissionsProtocol.constructAdditionalMessageFilter() in the DWN
SDK — no separate sync target is needed.
