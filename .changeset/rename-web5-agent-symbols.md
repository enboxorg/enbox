---
"@enbox/agent": minor
"@enbox/dwn-clients": minor
"@enbox/api": patch
"@enbox/auth": patch
---

BREAKING: Rename Web5-prefixed symbols to Enbox-prefixed across agent and dwn-clients

- `Web5Agent` → `EnboxAgent`, `Web5UserAgent` → `EnboxUserAgent`, `Web5PlatformAgent` → `EnboxPlatformAgent`
- `Web5RpcClient` → `EnboxRpcClient`, `Web5Rpc` → `EnboxRpc`, `HttpWeb5RpcClient` → `HttpEnboxRpcClient`, `WebSocketWeb5RpcClient` → `WebSocketEnboxRpcClient`
- `Web5ConnectAuthRequest` → `EnboxConnectAuthRequest`, `Web5ConnectAuthResponse` → `EnboxConnectAuthResponse`
- Deprecated aliases preserved for all renamed symbols
- File renamed: `web5-user-agent.ts` → `enbox-user-agent.ts`
- All downstream packages updated: @enbox/api, @enbox/auth
