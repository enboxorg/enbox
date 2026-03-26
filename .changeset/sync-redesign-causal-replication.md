---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
"@enbox/agent": patch
---

feat: causal scoped replication for multi-master DWN sync

Redesigns DWN sync as a causal, scoped, multi-master replication system.

dwn-sdk-js:
- ProgressToken replaces opaque string cursor ({ streamId, epoch, position, messageCid })
- EventLog interface: emit() returns ProgressToken, getReplayBounds() for gap metadata
- ProgressGap detection with 410 status and structured metadata
- EventEmitterEventLog: epoch generation, streamId derivation, cursor validation
- MessagesFilter: protocolPathPrefix and contextIdPrefix with range filter conversion
- ProtocolsConfigure shadow filter for prefix-scoped subscriptions
- JSON schemas updated for ProgressToken and prefix filter fields

dwn-clients:
- ResubscribeFactory, createJsonRpcAck, TrackedSubscription use ProgressToken
- WebSocket client handles ProgressToken events and acks

dwn-server:
- FlowController: ProgressToken matching with streamId/epoch domain validation
- NatsEventLog: ProgressToken emit/read/subscribe, getReplayBounds, cursor validation
- Subscription ack handler validates ProgressToken object shape

agent:
- ReplicationLedger: per-link durable state with CRUD and checkpoint helpers
- Delivery-order tracking: ordinal-based pull progression handling concurrent completion
- Closure resolver: 6 dependency classes with BFS traversal, caching, depth limits
- Causal grant ordering: temporal validity at closure root commit point
- Gap detection triggers repair; repair with retry scheduling and degraded_poll fallback
- Echo-loop suppression scoped per remote endpoint
- Subset scope prefix filtering (agent-side + SDK-level)
- Per-link connectivity state with aggregate getter
- Observability events: 9 typed event kinds at all state transitions
- Squash convergence handled by DWN SDK built-in performRecordsSquash
