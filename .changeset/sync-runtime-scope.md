---
"@enbox/agent": patch
---

refactor(agent): introduce a SyncRuntime timer scope for the sync engine

Adds an internal `SyncRuntime` ownership scope created per `startSync` generation. The engine's sync-interval timer (poll cadence and live settle check) is now armed through the scope under a stable key, and every runtime transition disposes the scope — cancelling all owned timers and refusing further arming — instead of hand-clearing a `_syncIntervalId` field. Poll/live interval callbacks read `runtime.disposed` in place of the previous `_engineGeneration` capture-and-compare checks: a callback belonging to a stopped generation is structurally unreachable rather than individually fenced. No behavior change; first step of the runtime-scope (Phase-2) refactor.
