---
"@enbox/agent": major
"@enbox/auth": minor
"@enbox/api": major
"@enbox/dwn-clients": major
"@enbox/common": major
"@enbox/crypto": major
"@enbox/dwn-sdk-js": major
"@enbox/dids": major
"@enbox/dwn-server": patch
---

refactor: consolidate connect flows, remove all deprecated Web5 aliases, remove dead abstractions

BREAKING CHANGES:

**@enbox/agent**
- `WalletConnect` namespace moved to `@enbox/auth` — import from `@enbox/auth` instead
- `AgentSyncApi` removed — `EnboxUserAgent.sync` is now typed as `SyncEngine` directly
- `Web5Agent`, `Web5PlatformAgent`, `Web5UserAgent` type aliases removed
- `PushedAuthRequest`, `PushedAuthResponse` types removed
- `Oidc` namespace removed — use `EnboxConnectProtocol` instead
- `EnboxConnectAuthRequest`/`EnboxConnectAuthResponse` types removed — use `EnboxConnectRequest`/`EnboxConnectResponse`
- `DwnDidService.enc`/`.sig` fields removed from `types/dwn.ts`

**@enbox/api**
- `Web5`, `Web5Params`, `Web5AnonymousOptions`, `Web5AnonymousApi` aliases removed — use `Enbox` equivalents

**@enbox/dwn-clients**
- `Web5Rpc`, `Web5RpcClient`, `HttpWeb5RpcClient`, `WebSocketWeb5RpcClient` aliases removed — use `DwnRpc`/`DwnRpcClient`/`HttpDwnRpcClient`/`WebSocketDwnRpcClient`

**@enbox/common**
- `Web5LogLevel`, `Web5LoggerInterface` aliases removed — use `EnboxLogLevel`/`EnboxLoggerInterface`

**@enbox/crypto**
- `ExtendedCryptoApi` removed (was unused)

**@enbox/dwn-sdk-js**
- `MessageSubscriptionHandler`, `RecordSubscriptionHandler` type aliases removed — use `SubscriptionListener`

**@enbox/dids**
- `DwnDidService.enc`/`.sig` fields removed — these were never consumed by production code

**@enbox/dwn-server** (patch — internal only)
- `Web5ConnectRequest`, `Web5ConnectResponse`, `SetWeb5ConnectRequestResult`, `Web5ConnectServer` internal aliases removed

Non-breaking changes:
- `close()` added to `SyncEngine` interface
- Connect flow helpers deduplicated into `@enbox/auth/connect/lifecycle.ts`
- `WalletConnect` client moved to `@enbox/auth` (new export, minor bump)
