---
"@enbox/dwn-sdk-js": patch
---

feat: ValidationStateReader with uniform admission

Consolidates validation-time state reads behind one narrow `ValidationStateReader` interface (initial-write and record-chain fetches, immediate-parent and role queries, grant fetches, protocol-definition fetches, `$recordLimit` counts, and prior-data checks). Validation modules no longer read `MessageStore` directly for those checks.

`processMessage()` and `applyReplicatedMessage()` now share the same admission checks. There is no replication-specific validation path: replication calls normal admission and then maps ordinary missing-dependency failures to structured `Incomplete` outcomes. Parent and role checks can use retained initial writes when no local tombstone exists, initial writes are governed by the latest protocol definition, and updates are governed by the retained initial write's timestamp.

`PermissionsProtocol.fetchGrant` and `getScopeFromPermissionRecord(...)` now use the reader, `CoreProtocol.preProcessWrite` receives the reader, and `HandlerDependencies` gains a required `validationStateReader`. A lint rule prevents validation modules from importing `MessageStore` directly, and recording-reader tests pin the validation read set.
