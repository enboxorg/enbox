---
"@enbox/agent": patch
---

refactor(agent): introduce a SyncRuntime timer scope for the sync engine

Adds an internal `SyncRuntime` ownership scope created per `startSync` generation. The engine's sync-interval timer (poll cadence and live settle check) is now armed through the scope under a stable key, and every runtime transition disposes the scope — cancelling all owned timers and refusing further arming — instead of hand-clearing a `_syncIntervalId` field. Each armed callback carries an ownership token that is re-checked when the event loop delivers a firing, so a callback whose timer was replaced or whose scope was disposed never starts — including firings the event loop had already queued, which `clearInterval` alone cannot retract. Async callback bodies that already started remain governed by lifecycle supervision and their own `disposed` re-checks after awaits. No behavior change; first step of the runtime-scope (Phase-2) refactor.
