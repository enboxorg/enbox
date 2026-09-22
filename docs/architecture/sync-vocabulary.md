# Sync engine vocabulary

This is the canonical vocabulary for `packages/agent/src/sync-next/` and its
shared `sync-*` helpers. Use one name per concept; do not revive terminology
from the deleted reconciliation/repair engine.

## Durable state

| Concept | Canonical name |
|---|---|
| One tenant, normalized endpoint, projection, and authorization epoch | **exact link** |
| Durable remote-to-local progress | **pull handled-through watermark** — `pullHandledThrough` |
| Durable local-to-remote progress | **push handled-through watermark** — `pushHandledThrough` |
| Remote input retained because local admission is not yet possible | **quarantine receipt** |
| Local input still owed to one exact remote | **delivery obligation** |
| Stable endpoint-independent identity for equivalent source bindings | **logical target** |
| Namespace in which watermark positions are comparable | **token domain** — exact `(streamId, epoch)` |

A handled-through watermark means every preceding source entry was either
settled or retained as sparse work. It is not a claim that quarantine and
delivery are empty.

The local DWN is the accepted-message set. Successful rows are compressed into
watermarks; there is no second accepted/sent-accepted ledger.

## Runtime

| Concept | Canonical name |
|---|---|
| One bounded `MessagesQuery` result | **page** |
| Repeat pages until observed drain with no trailing wake | **covering pass** |
| Cursorless subscription notification that source work may exist | **wake** |
| Whether a role/owner source has no uncovered wake or quarantine | **pull currentness** |
| Per-endpoint concurrency bound plus short outage circuit | **endpoint gate** |
| Short-lived `(tenant, CID, endpoint)` transfer hint | **echo suppression** |
| Explicit reset-before-purge disaster recovery | **rebuild** |

Subscriptions wake the durable page loop; they are not a second replication
path and their cursors are not checkpoint evidence. Pull and push loops are
independent. Sparse retry eligibility comes from durable attempt metadata and
optional `Retry-After`; it does not own a per-record timer.

## Catalog

| Concept | Canonical name |
|---|---|
| Durable registration of an owned identity and selected protocols | **sync registration** |
| Accepted foreign context and its current verified role | **followed source** |
| Stable lifetime of one followed context | **acceptance** — `acceptanceId` |
| Ordered strongest-to-weakest candidate roles | **role group** |

Catalog changes invalidate target planning and refresh exact-link sessions.
Role loss re-resolves the role group; if no role remains, the followed source
is retired.

## Verb rules

- **consume** one page.
- **commit** dispositions and its handled-through watermark atomically.
- **settle** a quarantine receipt or delivery obligation.
- **retry** sparse work without moving a watermark.
- **retire** an obsolete binding while preserving recoverable logical-target input.
- **remove** state after explicit owner intent.
- **rebuild** by resetting progress before purging reconstructible sparse state.

Do not use *repair*, *reconcile*, *dead letter*, *quota probe*, *feed
convergence*, or *captured head* for watermark-engine behavior. Those names
belonged to deleted mechanisms, not aliases for the concepts above.
