---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
"@enbox/browser": patch
"@enbox/dwn-server": patch
---

feat(agent): graceful, self-healing handling of quota-blocked sync pushes + observable per-remote sync status

Sync pushes rejected for tenant storage/message quota are no longer retried forever (the console-error flood that spun the remote). They are now detected precisely (`isQuotaExceededError`, newly exported from `@enbox/dwn-clients`) and deferred on a per-link, per-message exponential-backoff probe. Feed checkpoints may advance past the explicit omission, so a blocked message neither stalls newer records nor prevents other remotes from progressing; due and manual retries target the omitted CID independently of that checkpoint. If a later update or tombstone makes the old bytes unreachable, its acknowledgement converts the block into a resolved per-link omission: it is healthy, never retried, and remains durable only long enough to explain the intentional feed-CID difference.

Live sync now suppresses the remote subscription echo of messages already materialized in the same local tenant when it pushes them to that endpoint. The matching pull delivery still advances its durable checkpoint, but it no longer performs a redundant remote `MessagesRead` or re-applies data already present in the local DWN; tenant- and endpoint-scoped tracking preserves multi-identity isolation and normal multi-provider fan-out. Canonicalized bootstrap messages that may not exist in the destination tenant still follow normal pull admission. Pull deliveries accepted while a link is still initializing are also committed, preventing an early event from pinning every later checkpoint behind an unfinished ordinal.

Replicated metadata-only historical writes continue through storage-quota preflight without charging their declared payload size, while message-count quota and all normal data-bearing quota checks remain enforced. This lets a later tombstone or smaller update replay its retained initial-write dependency without exposing a dataless current record. Same-CID data retries against ancestry-only storage are deferred instead of falsely acknowledged, embedded message data is rejected in favor of the validated transport field, and storage reporting now counts only latest base-state data rather than metadata-only history.

New observability, re-exported through `@enbox/browser` for dapp "remotes" panels: `SyncEngine.getRemoteSyncStatus()` returns a per-`(tenant, remote)` snapshot (`healthy | quota-blocked | degraded | offline`, blocked count, next-probe time, last error/activity); `SyncEngine.retryRemoteNow()` directly re-probes only the selected remote; `push:quota-blocked` / `push:quota-cleared` events include durable timing and clear resolution; and `SyncHealthSummary` gains `quotaBlockedMessageCount`.
