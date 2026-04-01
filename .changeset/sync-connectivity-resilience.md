---
"@enbox/agent": minor
"@enbox/dwn-clients": minor
---

feat: browser connectivity detection and WebSocket heartbeat for sync resilience

Adds browser `online`/`offline` and `visibilitychange` event listeners to the
sync engine so that network switches, sleep/wake, and tab foregrounding trigger
immediate SMT reconciliation instead of waiting for WebSocket close events
(which can take minutes on silent TCP death). Safe no-op in Node environments.

Adds application-level heartbeat (ping/pong) to `JsonRpcSocket` — sends
`rpc.ping` every 30s and closes the connection if no response arrives within
10s. This detects silently dead WebSocket connections that TCP keepalive misses,
triggering the existing exponential-backoff reconnection.
