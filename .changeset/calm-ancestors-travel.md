---
'@enbox/agent': patch
'@enbox/dwn-clients': patch
'@enbox/dwn-server': patch
---

Carry explicitly ancestry-only initial record writes over pooled WebSocket replication connections while preserving HTTP fallback and rejecting unmarked missing payloads.
