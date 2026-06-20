# @enbox/dwn-clients

Client libraries and shared types for communicating with [DWN Servers](../dwn-server).

## What's Included

### Transport Clients

| Export | Description |
|---|---|
| `HttpDwnRpcClient` | HTTP client for DWN JSON-RPC endpoints |
| `WebSocketDwnRpcClient` | WebSocket client for DWN JSON-RPC with subscriptions |
| `EnboxRpcClient` | Transport multiplexer — routes to HTTP or WebSocket based on URL scheme |
| `HttpEnboxRpcClient` | HTTP client with DID RPC support |
| `WebSocketEnboxRpcClient` | WebSocket client with DID RPC support |
| `DwnRegistrar` | HTTP client for DWN tenant registration (proof-of-work challenge flow) |

### JSON-RPC

| Export | Description |
|---|---|
| `createJsonRpcRequest` | Factory for JSON-RPC 2.0 request objects |
| `createJsonRpcSuccessResponse` | Factory for JSON-RPC success responses |
| `createJsonRpcErrorResponse` | Factory for JSON-RPC error responses |
| `JsonRpcSocket` | Persistent WebSocket wrapper for JSON-RPC messaging |

### Shared Types

Types used by both `@enbox/dwn-server` (server-side) and clients:

| Type | Description |
|---|---|
| `ServerInfo` | Full `/info` endpoint response shape |
| `ProofOfWorkChallengeModel` | `GET /registration/proof-of-work` response |
| `RegistrationData` | Tenant registration data (`did` + `termsOfServiceHash`) |
| `RegistrationRequest` | `POST /registration` request body |
| `JsonRpcRequest` / `JsonRpcResponse` | JSON-RPC 2.0 message envelopes |
| `DwnRpcRequest` / `DwnRpcResponse` | DWN-specific RPC request/response |

### Utilities

| Export | Description |
|---|---|
| `concatenateUrl` | Join a base URL and path segment with exactly one `/` |
| `DwnServerInfoCacheMemory` | In-memory cache for `ServerInfo` with TTL |

## Usage

```typescript
import { EnboxRpcClient } from '@enbox/dwn-clients';

const rpc = new EnboxRpcClient();

// Send a DWN request over HTTP
const response = await rpc.sendDwnRequest({
  dwnUrl    : 'https://dwn.example.com',
  targetDid : 'did:dht:abc123',
  message   : recordsWriteMessage,
  data      : dataStream,
});

// Get server info
const info = await rpc.getServerInfo('https://dwn.example.com');
console.log(info.registrationRequirements); // ['proof-of-work-sha256-v0', 'terms-of-service']

// Register a tenant
import { DwnRegistrar } from '@enbox/dwn-clients';
await DwnRegistrar.registerTenant('https://dwn.example.com', 'did:dht:abc123');
```

## License

Apache-2.0
