---
"@enbox/agent": minor
"@enbox/auth": minor
---

feat(agent): per-delivery sync events, scoped one-shot sync, coalesced concurrency, and per-link replication status; feat(auth): explicit sync mode option

Sync engine (`@enbox/agent`):

- New `delivery:applied` sync event, emitted once per **freshly** admitted live-pull message with a routing descriptor (`interface`, `method`, `protocol`, `protocolPath`, `recordId`, `contextId`, `author`, `messageTimestamp`) so apps can invalidate exactly the affected state without re-querying. Echoes of messages the store already held (`Duplicate`/`Superseded` applies) do not emit — `admitClosure` now reports `freshCids` alongside `appliedCids`.
- `sync(direction?, options?)` accepts `options.did` to scope a one-shot run to a single registered identity's replication targets (an app-triggered "pull my inbox now" no longer re-reconciles every identity). An unregistered DID rejects.
- Concurrent `sync()` calls now coalesce into one queued follow-up run instead of throwing `Sync operation is already in progress` — joined requests merge (differing directions widen to both, differing scopes widen to unscoped) and share the follow-up's outcome.
- New `getReplicationLinks(tenantDid?)` returns read-only per-link snapshots (scope, status, connectivity, checkpoint positions, last activity). All links `'live'` is the per-identity caught-up signal for hot-added identities; `startSync()` resolving covers identities registered before start (now documented).
- End-to-end regression coverage for the peer-authored inbox pattern: an `anyone`-create record written by a foreign author into the tenant's remote DWN is delivered through live sync in real time, wakes local `MessagesSubscribe` subscribers, and emits `delivery:applied` — including for identities hot-added after `startSync()`.

Auth (`@enbox/auth`):

- `SyncOption` now accepts `'live'` and `{ mode: 'live' | 'poll', interval? }` in addition to `'off'`. The bare interval string form (which silently selects poll mode and gives up real-time delivery) is deprecated and logs a one-time warning; behaviour is otherwise unchanged.
