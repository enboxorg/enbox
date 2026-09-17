---
'@enbox/agent': patch
'@enbox/dwn-clients': patch
'@enbox/dwn-server': patch
---

Carry explicitly ancestry-only initial record writes over pooled WebSocket replication connections, fall back to HTTP when older servers explicitly reject that transport, and reject unmarked missing payloads.
