---
"@enbox/agent": patch
"@enbox/api": patch
---

fix: delegate encrypted write fails with 'Unable to get signer for author did:dht'

When a delegate writes to a protocol type with `encryptionRequired: true`, the write
failed because: (1) the delegate's local protocol definition lacked the owner's
`$encryption` keys needed for ProtocolPath encryption, (2) the internal protocol
definition lookup signed the ProtocolsQuery as the owner DID whose private key is
not available to the delegate, and (3) the protocol definition cache was not populated
after the delegate installed the owner's remote definition.

The delegate now fetches the owner's protocol definition (with `$encryption` keys)
from the remote DWN during auto-configure, resolves a ProtocolsQuery permission grant
for local lookups, and caches the definition after installation. If the remote
definition cannot be fetched for a protocol with encrypted types, the operation fails
loudly instead of silently downgrading security.
