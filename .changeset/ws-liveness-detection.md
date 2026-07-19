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
  reconnect loop. A probe pong supersedes an outstanding heartbeat entirely —
  deadline cleared and its pong handler removed, with heartbeat generations
  tracked by ping id — so a deadline armed before a tab freeze cannot kill a
  verified-alive connection on resume and a late stale pong cannot defuse a
  newer heartbeat's deadline.
- `WebSocketDwnRpcClient` registers browser wake listeners (network back
  online, tab foregrounded) that run `checkAllConnections()` across the pool
  AND a registry of sockets evicted from the pool mid-reconnect — the sockets
  parked in backoff are exactly the ones a wake must reach. Recovery starts
  the moment the page wakes instead of at the next throttled timer tick.
  `closeAllConnections()` removes the listeners and also closes reconnecting
  sockets so none survive shutdown to re-register into a cleared pool — and a
  reconnect already past its backoff cannot undo a close that raced it:
  establishment re-checks closure, discards the fresh WebSocket, and a
  user-closed socket is never re-registered by `onreconnected`.
- Exactly one socket per endpoint survives a reconnect racing a replacement
  connection: pool mutations are ownership-checked, so a superseded
  reconnected socket closes instead of overwriting the replacement, a
  completing replacement closes the socket it displaces, and a stale close
  cannot evict a connection it no longer owns. The losing socket's tracked
  subscriptions transfer to the winner, resuming from their last cursors
  with a `reconnected` notification — and a subscription caught
  mid-resubscription re-routes to the current owner, with pending requests
  rejected promptly on user close so the re-route is not delayed by the
  response timeout.
- `dwn-server` heartbeat now `terminate()`s a dead peer instead of initiating
  a close handshake the peer can never complete.
