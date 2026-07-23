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
shutdown, identity replacement, and successful grant refresh fence resources
bound to the previous authorization. Refresh reuses the delegate identity but
installs a new session lifetime; a failed or denied refresh leaves the existing
session active. `AuthManager` installs the exact active session before publishing
`session-start`. Its metadata is projected through an explicit public shape that
carries the same signal while keeping the authenticated agent capability and
recovery phrase out; higher layers follow the manager-owned session instead of
reconstructing one from the event payload.

Sync registration changes and ephemeral pull currentness are now observable.
Replication-link snapshots combine durable checkpoints with current controller
status, connectivity, and whether every accepted remote-feed wake is covered
by a completed pull pass; checkpoint events remain progress-only.
