---
"@enbox/agent": minor
"@enbox/dwn-clients": minor
"@enbox/dwn-server": minor
---

feat: browser connectivity detection, WebSocket heartbeat, and rpc.ping server handler

Adds browser `online`/`offline` and `visibilitychange` event listeners to the
sync engine. On offline, all active per-link connectivity states transition to
offline (reflected by the public `connectivityState` getter). On online or page
becoming visible, an immediate SMT reconciliation runs. Safe no-op in Node.

Adds application-level heartbeat (ping/pong) to `JsonRpcSocket` — sends
`rpc.ping` every 30s and closes the connection if no response arrives within
10s. Detects silently dead WebSocket connections that TCP keepalive misses.

Adds `rpc.ping` handler to the DWN server and a defensive unknown-method
guard to `JsonRpcRouter.handle()` (returns MethodNotFound instead of crashing).
