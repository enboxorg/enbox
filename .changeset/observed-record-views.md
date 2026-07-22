---
"@enbox/agent": patch
"@enbox/auth": patch
"@enbox/api": patch
"@enbox/browser": patch
"@enbox/cli": patch
---

Add `records.observe()` as the single high-level reactive Records primitive. It
publishes bounded immutable query snapshots, treats local subscription events
as wake hints, coalesces rematerialization, and reports loading, ready, stale,
or error currentness from the existing sync registration and link state.

Sessions now carry an owner-controlled `AbortSignal`; lock, disconnect,
shutdown, and identity replacement fence session resources, while grant refresh
retains the same session lifetime. The sanitized `session-start` metadata
includes that same signal without exposing the authenticated agent capability
or a newly created identity's recovery phrase.

Sync registration changes and ephemeral pull currentness are now observable.
Replication-link snapshots combine durable checkpoints with current controller
status, connectivity, and whether every accepted remote-feed wake is covered
by a completed pull pass; checkpoint events remain progress-only.
