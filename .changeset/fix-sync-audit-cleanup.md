---
"@enbox/agent": patch
---

fix(agent): sync engine audit cleanup — cursor safety, push retry, dead code removal

1. Live pull cursor only advances on successful processRawMessage.
   Previously the cursor advanced even when processing failed,
   permanently losing the event.

2. Failed push CIDs are re-queued for retry on the next debounce
   cycle (1s backoff). Previously they were permanently lost until
   the SMT integrity check.

3. Removed ~180 lines of dead code: walkTreeDiff, Semaphore,
   getRemoteSubtreeHash, getRemoteLeaves, REMOTE_CONCURRENCY.
   These were replaced by the batched diff mechanism.

4. Simplified openLivePullSubscription grant lookup — removed
   redundant try/catch fallback (unified scope matching handles it).

5. Fixed openLocalPushSubscription to request MessagesSubscribe
   grant instead of MessagesRead (semantically correct).

6. Cached getSyncPermissionGrantId result in diffWithRemote to
   avoid redundant lookup.

7. flushPendingPushes now pushes to all endpoints in parallel
   instead of sequentially.
