---
"@enbox/dwn-clients": patch
---

Park WebSocket connection attempts while browsers explicitly report that they are offline, and treat heartbeat and health-probe misses as normal connection lifecycle transitions.
