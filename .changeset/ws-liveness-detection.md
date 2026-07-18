---
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
---

feat: wake-triggered WebSocket liveness checks and immediate dead-peer teardown

The socket heartbeat rides on JS timers, which browsers throttle or freeze in
backgrounded tabs and across system sleep — a dead connection could go
undetected for 60–100s while subscriptions silently missed events.

- `JsonRpcSocket.checkHealth()` forces an immediate liveness verdict: a live
  connection is probed with a short-deadline `rpc.ping` (a miss force-closes
  and hands off to auto-reconnect), a reconnecting socket has its pending
  backoff wait fast-forwarded, and a disconnected socket starts a fresh
  reconnect loop. A probe pong also clears a stale heartbeat deadline armed
  before a tab freeze so it cannot kill a verified-alive connection on resume.
- `WebSocketDwnRpcClient` registers browser wake listeners (network back
  online, tab foregrounded) that run `checkAllConnections()` across the pool,
  so recovery starts the moment the page wakes instead of at the next
  throttled timer tick. Listeners are removed by `closeAllConnections()`.
- `dwn-server` heartbeat now `terminate()`s a dead peer instead of initiating
  a close handshake the peer can never complete.
