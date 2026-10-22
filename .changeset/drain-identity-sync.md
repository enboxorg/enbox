---
"@enbox/auth": patch
---

Drain and remove an identity's durable sync registration before deleting its keys and metadata. Serialize deletion with auth lifecycle changes and retain delegate signing keys while grant revocations are pending.
