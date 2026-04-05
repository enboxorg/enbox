---
"@enbox/agent": patch
"@enbox/api": patch
---

fix: prepareProtocol re-installs with encryption when existing definition lacks $encryption keys

When the wallet already had a protocol installed without $encryption keys (from
before the encryption fix, or synced from a remote DWN with the old definition),
the delegate received a protocol definition that lacked $encryption — causing
encrypted writes to fail with 'does not have encryption configured'.

prepareProtocol now detects this and re-configures with encryption: true.
TypedEnbox._autoConfigureOnce now re-configures locally when the synced protocol
differs from the app definition (expected for delegates — the synced version has
$encryption keys) to populate the agent's protocol definition cache.
