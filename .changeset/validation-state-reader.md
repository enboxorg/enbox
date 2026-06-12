---
"@enbox/dwn-sdk-js": patch
---

feat: ValidationStateReader with uniform admission

Consolidates validation-time state reads behind one narrow `ValidationStateReader` interface (initial-write and record-chain fetches, immediate-parent and role queries, grant fetches, protocol-definition fetches, `$recordLimit` counts, and prior-data checks) without introducing a replicated validation mode. `processMessage()` and `applyReplicatedMessage()` now share the same admission checks; replication stays outside validation as a structured-result adapter that maps ordinary missing-dependency failures to `Incomplete` outcomes.

Rows 3, 4, and 6 from the sync replay-basis plan are implemented as uniform admission rules: parent and role checks may use a retained initial write when no local tombstone exists, initial writes are governed by the latest protocol definition, and updates are governed by the retained initial write's timestamp. Validation modules are lint-banned from importing `MessageStore` directly, and a recording reader plus a committed read-trace artifact pin the replay-basis read set. `PermissionsProtocol.fetchGrant` and `getScopeFromPermissionRecord(...)` now use the reader, `CoreProtocol.preProcessWrite` receives the reader, and `HandlerDependencies` gains a required `validationStateReader`.
