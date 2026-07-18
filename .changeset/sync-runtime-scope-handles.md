---
"@enbox/agent": patch
---

refactor(agent): retire getGeneration from the sync collaborators in favor of runtime-scope handles

The connectivity manager and link-recovery coordinator now capture a read-only `SyncRuntimeHandle` when they start work and fence their continuations on `scope.disposed` — a runtime transition disposes exactly the scope those captures reference, so the staleness semantics are unchanged while the engine-generation plumbing disappears from their operation contracts. The quota manager's probe staleness becomes purely the caller's `shouldContinue` fence: the engine composes a transition fence into every probe it threads down, valid from any state (an active scope trips when disposed; an already-disposed scope trips when a new runtime replaces it), so one-shot callers such as a stopped-state `retryRemoteNow` keep probing exactly as before. No behavior change; third step of the runtime-scope (Phase-2) refactor.
