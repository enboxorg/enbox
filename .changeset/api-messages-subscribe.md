---
"@enbox/api": patch
---

feat(api): first-class `messages.subscribe()` — the message-level local change feed

New `enbox.dwn.messages.subscribe({ filters?, cursor?, from? })` returning a lightweight `MessagesLiveQuery`: one `event` per message recorded on the tenant's log across every interface the filters cover (multiple filters per subscription), each carrying the raw message plus a routing `MessageDescriptor` (`interface`, `method`, `protocol`, `protocolPath`, `recordId`, `contextId`, `author`, `messageTimestamp`). Where `records.subscribe()` hydrates full `Record` objects for one filter, this is the cache-invalidation primitive: subscribe once per profile on the local store — which sync keeps populated, so events fire for sync-applied messages too — and route each change without re-querying. Includes transport lifecycle events (`eose`, `disconnected`/`reconnecting`/`reconnected`, terminal `error`), cursor resume, remote (`from`) targeting, and delegated `Messages.Read` grant resolution for single-protocol filter sets.
