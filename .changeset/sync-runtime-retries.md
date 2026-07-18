---
"@enbox/agent": patch
---

fix(agent): scope-own link-init retry timers and cancel them on identity mutations

Pending rate-limit (Retry-After) link-initialization retries move from an engine-held timer map into the `SyncRuntime` scope as keyed one-shot timers, gaining the scope's guarantees: a runtime transition disposes them, and a firing the event loop queued before a replacement or disposal never starts. `SyncRuntime` adds `armTimeout`, `hasTimers`, and `clearTimers` for keyed one-shot arming and predicate-based queries.

Behavioral fix: `updateIdentityOptions` and `unregisterIdentity` now cancel an identity's pending init retries unconditionally. Previously the cancellation only ran when live links were being rebuilt — but in exactly the rate-limited case the link controller was already dropped before the retry was armed, so the timer survived the mutation and could re-create a superseded durable link and reopen live subscriptions with the replaced scope and authorization epoch (or for an unregistered identity).
