---
"@enbox/auth": patch
---

fix: scope delegate sync to granted protocols instead of global sync

The sync engine was attempting to sync all protocols (including the DWN
permissions protocol) for delegate sessions. This happened because:

1. `switchIdentity` / session restore registered delegates with
   `protocols: []` (global sync) instead of deriving the protocol list
   from stored grants.
2. `importDelegateAndSetupSync` correctly passed `connectedProtocols`,
   but if the identity was already registered from a prior session with
   `protocols: []`, the stale registration persisted.

Now:
- `switchIdentity` derives the protocol list from stored grants by
  querying the delegate's DWN for grant records and extracting
  `scope.protocol` (excluding the permissions protocol itself).
- `importDelegateAndSetupSync` falls back to `updateIdentityOptions`
  when the identity is already registered, ensuring the protocol
  list is always current.
