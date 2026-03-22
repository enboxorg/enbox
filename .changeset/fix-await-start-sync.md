---
"@enbox/auth": patch
---

fix(auth): await startSyncIfEnabled so subscriptions are fully opened before connect returns

startSyncIfEnabled was called as fire-and-forget (not awaited) at all 6
call sites. This caused a race condition where startLiveSync would run
before the identity and grants were fully persisted, resulting in 0 live
subscriptions and no sync activity. Now awaited so the sync engine is
fully initialized before the connect/restore flow returns.
