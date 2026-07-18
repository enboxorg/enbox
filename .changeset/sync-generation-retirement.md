---
"@enbox/agent": patch
---

refactor(agent): retire the engine generation counter and move sync mode onto the runtime scope

`_engineGeneration` is deleted. The last consumers — the live subscription handler guards (`createLinkStalePredicate` and the push handler's staleness closure) — capture the runtime scope at subscription-open time and fence on `scope.disposed || !controller.isActive`, exactly equivalent since the counter was only ever incremented by transitions that also dispose the captured scope. `_syncMode` moves onto the scope as `SyncRuntime.mode`, set at construction for the generation and reading `undefined` once disposed — reproducing the old reset-on-transition without a separate field. Completes the Phase-2 runtime-scope refactor: lifecycle staleness is now expressed solely through scope disposal, transition fences, and controller identity.
