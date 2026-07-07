---
"@enbox/dwn-clients": patch
"@enbox/agent": patch
"@enbox/auth": patch
---

fix: release sockets and store handles on shutdown so CLI processes exit

WebSocket RPC connections are pooled process-wide with heartbeat timers and were never closed, keeping the event loop alive after AuthManager.shutdown() resolved; the agent's DWN stores, DID resolver cache, and vault/secret stores also stayed open, wedging same-dataPath reopens and cross-process writes. Adds WebSocketDwnRpcClient.closeAllConnections() and a close() contract to EnboxRpc, a full EnboxUserAgent.shutdown() lifecycle, and delegates AuthManager.shutdown() to it.
