---
"@enbox/auth": patch
"@enbox/agent": patch
---

fix(auth): await startSyncIfEnabled so sync is fully initialized before connect returns

fix(agent): replace broken tryGetCidSync with async Message.getCid in local push handler

Two fixes for live and poll sync:

1. startSyncIfEnabled was fire-and-forget at all 6 call sites, causing a
   race where sync started before grants were persisted. Now awaited.

2. tryGetCidSync attempted to compute a SHA-256 CID synchronously via a
   fire-and-forget microtask — the CID was always undefined, causing every
   local write event to be silently dropped. Replaced with an async handler
   that awaits Message.getCid() directly.
