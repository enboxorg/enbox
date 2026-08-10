---
"@enbox/dids": patch
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/api": patch
"@enbox/browser": patch
---

Resolve and cache DID-advertised DWN endpoints, expose friendly endpoint status with an opt-in service-config wake, and preserve authoritative endpoints during recovery unless explicitly replaced. Connection snapshots now expose an immediate `disconnecting` phase, and owned `Enbox.disconnect()` calls surface teardown failures.

Remove the obsolete `getDwnEndpointUrlsForTarget()` local/remote union API and `remoteEndpointsOnly` request marker; callers now use DID-advertised endpoints and explicitly compose any known local endpoint they need.

Use `AuthManager.restoreFromPhrase()` as the single phrase-recovery entry point; generic `connect()` and `connectVault()` no longer accept a recovery phrase.
