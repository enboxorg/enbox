---
"@enbox/dwn-sdk-js": patch
---

feat: ValidationStateReader and replicated validation mode

Consolidates every validation-time state read behind one narrow `ValidationStateReader` interface (initial-write/record-chain fetches, the immediate-parent and role queries, grant fetch, protocol-definition fetch, the `$recordLimit` count, and the prior-data checks), threads a per-call `ValidationMode: 'live' | 'replicated'` from `processMessage` / `applyReplicatedMessage` through `MethodHandler.handle()`, and implements the replicated-validation divergences for read-set table rows 3 (compacted-parent initial-write fallback with tombstone exclusion), 4 (initial-write role-record fallback with tombstone exclusion), and 6 (governing protocol config selected by the initial write's own timestamp against retained config history). Validation modules are lint-banned from importing `MessageStore` directly, and a recording reader plus a committed read-trace artifact pin the replay-basis read set. `PermissionsProtocol.fetchGrant` and `getScopeFromPermissionRecord(tenant, messageStore, ...)` move to / take the reader, `CoreProtocol.preProcessWrite` receives the reader, and `HandlerDependencies` gains a required `validationStateReader`.
