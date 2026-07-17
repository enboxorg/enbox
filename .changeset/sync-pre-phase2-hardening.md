---
"@enbox/agent": patch
---

fix(agent): harden sync lifecycle ahead of the runtime-scope refactor

- `clear()`/`close()` now hold the exclusive sync lock through their destructive phase, so a concurrent `sync()`, `drainTo()`, or `retryRemoteNow()` can no longer interleave with the wipe (resurrecting replication links or the drain endpoint) or crash against a mid-close database.
- The DID-resolution link-init retry loop checks the runtime generation between backoff attempts, so a retry can no longer re-activate a link controller and reopen live subscriptions after `stopSync()`/`close()` tore the runtime down.
- `SyncReplicationLinkStoreLevel.persistCheckpoint` merges checkpoints monotonically within a token domain instead of overwriting, so a persist from a stale in-memory link instance can never regress `contiguousAppliedToken`. A stream/epoch change still replaces the checkpoint (deliberate feed reset), and explicit `resetCheckpoint` still overwrites.
