---
"@enbox/auth": patch
"@enbox/agent": patch
---

fix(auth): store delegate grants in both delegate and connected DID partitions

fix(agent): propagate permission grant errors instead of swallowing them

Permission grants are now stored in both the delegateDid's and connectedDid's
local DWN partitions during the connect flow.  Previously grants were only
stored in the delegateDid partition, but the DWN needs them in the connectedDid
partition to authorize delegate operations (MessagesRead, MessagesSync) against
that tenant.  This caused sync push to silently skip all messages.

Grant lookup failures in the sync engine now throw instead of being silently
swallowed.  When a delegateDid is present, the grant is mandatory — returning
undefined caused downstream operations to proceed without authorization and
fail silently.
