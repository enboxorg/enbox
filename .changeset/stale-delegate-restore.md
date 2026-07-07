---
"@enbox/auth": patch
"@enbox/api": patch
---

fix: restore the active identity (not a stale delegate), remove revoked delegates on disconnect, and surface authorization failures in delegate protocol ensure

restoreSession preferred any connected identity over the persisted active marker, so a leftover delegate from a disconnected session (grants revoked) shadowed the current one and every call failed with 401. Disconnect now also removes the dead delegate identity locally after clean revocation (kept while revocations are queued for retry), and TypedEnbox reports the query status when the wallet's protocol definition cannot be fetched instead of misreporting a revoked grant as a missing protocol.
