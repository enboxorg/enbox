---
"@enbox/agent": patch
"@enbox/auth": patch
---

Wait for subscription closes retained after stops or source removal before unregistering an identity, and share stored identity deletion ordering across explicit and delegated cleanup.

Preserve delegate keys when disconnect or revocation retirement cannot immediately settle local sync work.

Fence retained identity task groups and initialization retries before re-registering after a timed-out stop or sibling unregister, allowing fresh foreground role operations while keeping old captured runners closed.
