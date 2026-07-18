---
"@enbox/agent": patch
---

refactor(agent): move one-shot sync paths onto the runtime transition fence

The queued `sync()` follow-up, the `retryRemoteNow` chain, the DID-resolution link-init retry loop, and link initialization drop their engine-generation captures. Runtime-scoped work (link init and its retry loop — reachable only under a live runtime) fences on the captured scope's `disposed` flag; any-state work (queued sync runs, `retryRemoteNow`) captures the transition fence, which trips on runtime start/stop/clear/close from any starting state. Every transition — including the `clear()`/`close()` destructive phase, which previously bumped the generation — now installs a fresh disposed scope object, so fences captured under an already-disposed scope also observe it. Behavior-preserving; first half of the Phase-2 finale (the remaining generation sites are the subscription-handler guards, migrating with the `_syncMode` relocation).
