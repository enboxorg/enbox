---
'@enbox/dwn-server': patch
---

Bound WebSocket admission with startup defaults of 1,000 connections per process, 100 per direct peer IP, and 64 subscriptions per connection. The existing peer-IP request limiter now covers upgrade attempts and routed socket requests; only acknowledgements that advance a subscription event window are exempt. Servers behind a proxy must enforce client-IP admission there or size the direct-peer limit for that proxy.

Server shutdown now stops the listener before draining connections and closing DWN dependencies.

`WsApi` now wires its connection handler during construction and uses its `HttpApi` configuration as the single source of truth; the obsolete no-op `start()` method and unused public `dwn` property were removed.
