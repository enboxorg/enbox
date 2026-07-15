---
"@enbox/agent": minor
"@enbox/dwn-clients": minor
"@enbox/browser": patch
---

feat(agent): graceful, self-healing handling of quota-blocked sync pushes + observable per-remote sync status

Sync pushes rejected for tenant storage/message quota are no longer retried forever (the console-error flood that spun the remote). They are now detected precisely (`isQuotaExceededError`, newly exported from `@enbox/dwn-clients`), deferred on a per-message exponential-backoff re-probe, and self-heal on the first successful probe — when the remote quota grows, or the record is deleted/shrunk locally. A quota-blocked message no longer stalls newer, smaller records behind it.

New observability, re-exported through `@enbox/browser` for dapp "remotes" panels: `SyncEngine.getRemoteSyncStatus()` returns a per-`(tenant, remote)` snapshot (`healthy | quota-blocked | degraded | offline`, blocked count, next-probe time, last error); `SyncEngine.retryRemoteNow()` resumes a remote immediately (e.g. after the user buys quota); `push:quota-blocked` / `push:quota-cleared` events fire on the sync event stream; and `SyncHealthSummary` gains `quotaBlockedMessageCount`.
