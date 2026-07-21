---
"@enbox/dwn-clients": patch
"@enbox/agent": patch
---

fix: keep ordinary DWN requests on their endpoint's native transport

`EnboxRpcClient.sendDwnRequest` routes HTTP(S) requests over HTTP(S), where
the server advertises complete `dwn.processMessage` behavior. Subscriptions
continue to map HTTP(S) endpoints to the pooled WebSocket transport, and an
explicit `ws:`/`wss:` endpoint continues to use that transport directly.
This removes a second routing policy based on transient socket health and
keeps request transport selection deterministic.
