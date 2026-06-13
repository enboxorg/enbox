---
"@enbox/dwn-sdk-js": patch
---

feat: ValidationStateReader with uniform admission

Adds `ValidationStateReader` as the validation-time state access boundary and moves admission checks to use it instead of direct `MessageStore` reads.

`processMessage()` and `applyReplicatedMessage()` now share the same admission rules. Replication calls normal admission and maps missing local dependencies to structured `Incomplete` repair results outside validation.

Protocol definitions are resolved with the incoming message timestamp for all entry points, and RecordsWrite immutable-property checks now run after authentication/authorization without echoing stored immutable values.
