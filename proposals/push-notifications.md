# Proposal: Native Push Notifications for DWN Servers

## Status

Draft — design document for adding APNs, FCM, and Web Push notification support to `@enbox/dwn-server`.

## Problem Statement

The DWN system has an excellent real-time subscription system for connected clients: WebSocket subscriptions with cursor-based resume, flow control (sliding window of 32 unacked events), auto-reconnection with exponential backoff, and the `LiveQuery` API at the application layer.

**When the app is running and connected, events flow in sub-second.**

The gap: when a mobile or desktop app is closed, backgrounded, or the device loses connectivity, the WebSocket connection dies. The user doesn't know anything happened until they reopen the app and the sync engine catches up. There is no mechanism to wake the app or show a notification badge.

Push notifications solve the **"app is not running"** problem. They are the complement to WebSocket subscriptions — a lightweight wake-up signal from Apple/Google/browser push services that tells the OS to show a notification or wake the app to sync.

### What Exists Today

| Component | File | What It Does |
|---|---|---|
| WebSocket subscriptions | `dwn-server/src/connection/socket-connection.ts` | Per-connection subscription management with flow control |
| Flow control | `dwn-server/src/connection/flow-controller.ts` | Sliding window backpressure (default 32 unacked events) |
| EventLog (durable store) | `dwn-sdk-js/src/event-stream/durable-event-log.ts` | Cursor-based replay over the committed message-store feed |
| EventBus (NATS) | `dwn-server/src/plugins/event-bus-nats.ts` | Cross-process wake fan-out for durable EventLog drains |
| Admin webhooks | `dwn-server/src/admin/webhook-manager.ts` | Server-to-server HTTP callbacks for admin events only (not DWN message events) |
| Agent sync engine | `agent/src/sync-engine-level.ts` | Poll and live sync over durable feed cursors and WebSocket subscriptions |
| LiveQuery | `api/src/live-query.ts` | Reactive record change stream with dedup and lifecycle events |

### What Does Not Exist

- No push notification infrastructure (no APNs, FCM, Web Push)
- No device token / push subscription management
- No mechanism to wake a closed app when a DWN message arrives
- No way to show a native OS notification from a DWN event

---

## Target Platforms

| Platform | Service | Protocol |
|---|---|---|
| iOS | APNs (Apple Push Notification service) | HTTP/2 to `api.push.apple.com` |
| Android | FCM (Firebase Cloud Messaging) | HTTP v1 API to `fcm.googleapis.com` |
| Web browsers | Web Push (RFC 8030 / RFC 8291) | Standard VAPID + encryption to push service endpoint |

All three use the same basic model: the client obtains a **device token** (or push subscription endpoint), registers it with the server, and the server POSTs a payload to the push service when an event occurs.

---

## Architecture Decisions

### 1. Push Subscriptions: Server-Side Registration

Push subscriptions are stored server-side in a SQL table managed by `dwn-server`, following the same pattern as the existing `WebhookManager`.

**Why not DWN protocol-based?** While storing push subscriptions as DWN protocol records (like `JwkProtocolDefinition` or `IdentityProtocolDefinition`) would be more decentralized, the server-side approach is simpler and faster to ship. The data model is designed to be compatible with a future migration to protocol-based storage.

**Why server-side works well:**
- Fast SQL lookups on tenant DID, easily cached
- Clear separation: the server manages its own push delivery state
- Follows the established `WebhookManager` pattern
- No DWN SDK changes required

**Future migration path:** The server-side table can later become a cache layer over DWN protocol records. The push subscription data structure and agent-side API remain the same either way.

### 2. Architecture: Plugin First, Gateway Later

**For small-to-medium deployments (Phase 1):** A `PushNotificationManager` component inside `dwn-server` that hooks into the message processing path. Single deployment artifact, no additional infrastructure.

**For large-scale providers (Phase 5):** Extract the push logic into a standalone gateway service that listens for NATS wakes and reads the durable message-store feed. Independently scalable, crash-isolated.

The core logic is identical — what changes is only the event source (in-process hook vs. NATS consumer).

### 3. Event Hook Point

Rather than subscribing to the `EventLog` directly (which would require per-tenant subscriptions or internal `mitt` coupling), the push notification manager is invoked from `process-message.ts` after successful DWN message processing:

```
process-message.ts:
  reply = await dwn.processMessage(target, message, ...)
  if (reply.status.code === 202 || reply.status.code === 200) {
    pushNotificationManager?.onEvent(target, message)   // non-blocking
  }
```

**Why this approach:**
- Works with the same durable EventLog surface regardless of whether wakes are local or NATS-backed
- No changes to `dwn-sdk-js` required
- The hook is at the server layer, not the SDK layer
- Access to the exact message and target DID
- Easy to add rate limiting, dedup, and filtering before touching push providers

**For the gateway model (Phase 5):** The standalone service subscribes to NATS wakes and then drains the authoritative durable feed from the shared message store. NATS is only a wake signal; replay state stays in Level/SQL.

### 4. Authentication: Provider-Auth Token

Push subscription endpoints are authenticated via the existing provider-auth JWT system.

**Challenge:** The provider-auth JWT contains `sub` = accountId but **not** the tenant DID. The DID ↔ account mapping exists in the `RegistrationStore`.

**Auth flow:**
1. Client sends `Authorization: Bearer <provider-auth-jwt>` + request body containing `did`
2. Server validates the JWT via the existing `JwtProviderAuthPlugin` (or custom `ProviderAuthPlugin`)
3. Server looks up the DID in `RegistrationStore` to confirm `accountId` matches the JWT's `sub`
4. If match → request is authenticated for that DID

**Constraint:** Push notifications require `registrationStoreUrl` to be configured. Open DWN servers with no tenant tracking cannot meaningfully manage per-tenant push subscriptions.

### 5. Notification Content Levels

All four levels are supported, configurable per push subscription:

| Level | Push Payload | Privacy | Use Case |
|---|---|---|---|
| **wake-up** | `{ "type": "sync", "tenant": "<did>" }` | Maximum — push provider sees nothing useful | Background sync trigger |
| **metadata** | `{ "type": "event", "protocol": "...", "protocolPath": "..." }` | High — protocol URI only | "New chat message" (generic) |
| **rich** | `{ "title": "Alice", "body": "Hey!", "protocol": "..." }` | Lower — content visible to push provider | Full notification without app wake |
| **configurable** | Per `preferences` in the push subscription | Varies | User/protocol author chooses |

**Privacy constraint:** For encrypted protocols (`encryptionRequired: true`), the server cannot produce rich notifications because it can't decrypt the record data. The server automatically falls back to metadata level for encrypted records.

### 6. Independent from `$delivery`

Push notifications are a **server-to-device** concern, separate from provider-to-provider delivery. They hook into the EventLog directly regardless of how messages arrived at the DWN (direct write, provider-to-provider sync, or relay delivery).

The `$delivery` system handles "how does a message get from DWN A to DWN B." Push notifications handle "how does a user's device find out something happened in their DWN."

---

## Detailed Design

### Push Subscription API

```
POST /push/subscriptions
  Headers: Authorization: Bearer <provider-auth-jwt>
  Body: {
    "did": "did:dht:abc123...",
    "platform": "apns" | "fcm" | "web-push",
    "token": "<device-token-or-endpoint-url>",
    "keys": { "p256dh": "...", "auth": "..." },  // Web Push only
    "deviceId": "unique-device-id",
    "appId": "com.example.myapp",               // APNs topic / FCM project
    "preferences": {
      "level": "wake-up" | "metadata" | "rich",
      "protocols": ["https://example.com/chat"], // optional filter
      "protocolPaths": ["thread/message"]        // optional filter
    }
  }
  Response: 201 { "id": "uuid", ... }

GET /push/subscriptions
  Headers: Authorization: Bearer <provider-auth-jwt>
  Query: ?did=did:dht:abc123...
  Response: 200 { "subscriptions": [...] }

DELETE /push/subscriptions/:id
  Headers: Authorization: Bearer <provider-auth-jwt>
  Response: 204
```

### SQL Schema

```sql
CREATE TABLE pushSubscriptions (
  id          TEXT PRIMARY KEY,
  tenantDid   TEXT NOT NULL,
  platform    TEXT NOT NULL,  -- 'apns' | 'fcm' | 'web-push'
  token       TEXT NOT NULL,
  keys        TEXT,           -- JSON, Web Push only
  deviceId    TEXT NOT NULL,
  appId       TEXT,
  preferences TEXT,           -- JSON
  createdAt   TEXT NOT NULL,
  expiresAt   TEXT,

  UNIQUE(tenantDid, deviceId, platform)  -- one sub per device per platform
);

CREATE INDEX idx_push_tenant ON pushSubscriptions(tenantDid);
```

### Event → Push Flow

```
1. RecordsWrite arrives at DWN server (HTTP or WebSocket)
2. process-message.ts calls dwn.processMessage(target, message)
3. DWN returns reply with status 202 (accepted) or 200 (ok)
4. process-message.ts calls pushNotificationManager.onEvent(target, message)
5. PushNotificationManager (async, non-blocking):
   a. Is push enabled for this server? → no: return
   b. Does this target DID have push subscriptions? (cached lookup)
      → no: return
   c. Does this target DID have an active WebSocket connection with
      subscriptions? → yes: skip push (configurable grace period)
   d. For each push subscription for this tenant:
      - Apply protocol/protocolPath filter from preferences
      - Build payload based on notification level
      - Add to per-device batch queue
   e. After batch window (default 500ms), for each device:
      - 1 event: send individual notification
      - N events: send collapsed notification ("N new messages")
      - Call the appropriate PushProvider.send()
      - Handle result:
        - delivered → done
        - expired/invalid token → remove subscription from store
        - transient error → requeue with backoff (max 3 retries)
```

### WebSocket Dedup Strategy

A critical optimization: if the user's device has an active WebSocket subscription receiving events, sending a push notification is redundant.

The `PushNotificationManager` checks the in-process `ConnectionManager` for active WebSocket connections for the tenant DID. If there's an active connection with subscriptions, push is skipped (or delayed by a configurable grace period to handle the case where the WebSocket drops and push should take over).

For the gateway model (Phase 5), the DWN server would publish connection presence to NATS KV, and the push gateway would check it before dispatching.

### Notification Payload Examples

**Wake-up** (data-only, no visible notification):
```json
{
  "data": {
    "type": "sync",
    "tenant": "did:dht:abc123"
  }
}
```

**Metadata** (shows generic notification):
```json
{
  "notification": {
    "title": "New message",
    "body": "You have a new chat message"
  },
  "data": {
    "type": "event",
    "tenant": "did:dht:abc123",
    "protocol": "https://example.com/chat",
    "protocolPath": "thread/message"
  }
}
```

**Rich** (shows full notification):
```json
{
  "notification": {
    "title": "Alice",
    "body": "Hey, check this out!",
    "badge": 3,
    "sound": "default"
  },
  "data": {
    "type": "event",
    "tenant": "did:dht:abc123",
    "protocol": "https://example.com/chat",
    "protocolPath": "thread/message",
    "recordId": "bafyrei..."
  }
}
```

### ServerInfo Extension

The `/info` endpoint advertises push notification capability:

```typescript
// Addition to ServerInfo type in dwn-clients/src/server-info-types.ts
pushNotifications?: {
  supported: true;
  platforms: ('apns' | 'fcm' | 'web-push')[];
  vapidPublicKey?: string;  // needed by Web Push clients
};
```

---

## Configuration

```bash
# Feature toggle
DWN_PUSH_ENABLED=true

# Apple Push Notification service
DWN_PUSH_APNS_KEY_PATH=/path/to/AuthKey_XXXXXX.p8
DWN_PUSH_APNS_KEY_ID=XXXXXX
DWN_PUSH_APNS_TEAM_ID=XXXXXX
DWN_PUSH_APNS_ENVIRONMENT=production   # or "sandbox"

# Firebase Cloud Messaging
DWN_PUSH_FCM_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
# OR
DWN_PUSH_FCM_PROJECT_ID=my-project
DWN_PUSH_FCM_CREDENTIALS_JSON='{"type":"service_account",...}'

# Web Push (VAPID)
DWN_PUSH_VAPID_PUBLIC_KEY=<base64url-encoded-P256-public-key>
DWN_PUSH_VAPID_PRIVATE_KEY=<base64url-encoded-P256-private-key>
DWN_PUSH_VAPID_SUBJECT=mailto:admin@example.com

# Rate limiting and batching
DWN_PUSH_MAX_PER_DEVICE_PER_MINUTE=10     # per-device rate limit
DWN_PUSH_WEBSOCKET_GRACE_MS=0              # skip push when WS active (0 = immediate skip)
DWN_PUSH_BATCH_WINDOW_MS=500               # batch events before sending push
```

---

## File Layout

### New files

```
packages/dwn-server/src/push/
├── index.ts                          # Public exports
├── push-notification-manager.ts      # Core orchestrator
├── push-subscription-store.ts        # SQL CRUD for push subscriptions
├── push-provider.ts                  # PushProvider interface + PushResult type
├── push-payload-builder.ts           # Builds notification payloads by level
├── push-types.ts                     # Type definitions
└── providers/
    ├── apns-provider.ts              # Apple Push Notification service
    ├── fcm-provider.ts               # Firebase Cloud Messaging
    └── web-push-provider.ts          # Web Push (RFC 8030)
```

### Modified files

| File | Change |
|---|---|
| `dwn-server/src/config.ts` | New env vars for push configuration |
| `dwn-server/src/dwn-server.ts` | Create `PushNotificationManager` + `PushSubscriptionStore` in `#setupServer()` |
| `dwn-server/src/http-api.ts` | New routes: `POST/GET/DELETE /push/subscriptions` + tenant auth middleware |
| `dwn-server/src/json-rpc-handlers/dwn/process-message.ts` | Post-process hook: `pushNotificationManager?.onEvent(target, message)` |
| `dwn-clients/src/server-info-types.ts` | Add `pushNotifications` field to `ServerInfo` |

### No changes to dwn-sdk-js

The push system is entirely server-side. No SDK changes required.

### Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| `http2` (Bun built-in) | APNs HTTP/2 client | No additional dep |
| `jose` (already present) | APNs JWT signing, FCM service account auth | Already a dependency |
| `fetch` (Bun built-in) | FCM HTTP v1 API, Web Push delivery | No additional dep |

Web Push content encryption (RFC 8291) may require a small implementation using the existing `@enbox/crypto` primitives (ECDH P-256 + AES-128-GCM), or a lightweight dependency. TBD during implementation.

---

## Implementation Phases

### Phase 1: Core Infrastructure
- Push subscription store (SQL CRUD)
- Push provider interface and type definitions
- Push subscription HTTP endpoints with tenant auth

### Phase 2: Push Providers
- APNs provider (HTTP/2, JWT auth, token feedback handling)
- FCM provider (HTTP v1, service account auth, token feedback)
- Web Push provider (VAPID, RFC 8291 content encryption)

### Phase 3: Push Notification Manager
- Event hook in `process-message.ts`
- Orchestrator with batching, rate limiting, WebSocket dedup
- Configuration integration
- ServerInfo extension

### Phase 4: Agent-Side Integration
- `AgentPushApi` or extension to `AgentDwnApi`
- On app launch: register device token with DWN service endpoints
- On token refresh (APNs/FCM rotate tokens): update registration
- On logout: remove registration

### Phase 5: Gateway Extraction (Large Providers)
- Extract `PushNotificationManager` into standalone service
- NATS wake subscriber plus durable message-store feed reader
- Shared push subscription store (Postgres)
- Connection presence coordination via NATS KV

---

## Open Questions

1. **Rich notification content source**: For rich notifications, the server needs a title and body. Where does this come from?
   - Option A: A `$notification` directive in the protocol definition specifying which cleartext fields to use
   - Option B: A separate "notification metadata" record written alongside the main record
   - Option C: Start with metadata-level only; rich notifications are a future enhancement requiring protocol-level support
   - **Lean: Option C** — ship metadata-level first, revisit rich content when there's demand

2. **Multi-provider dedup**: If a user has DWNs at Provider A and Provider B, both with push enabled, duplicate notifications could occur.
   - Option A: Agent registers push subscriptions with one "primary" provider only
   - Option B: Each push notification includes a `messageCid` and the client deduplicates locally (via notification `collapseKey` / `thread-id`)
   - **Lean: Option A for now**, revisit when provider-to-provider sync is implemented

3. **Token rotation**: APNs and FCM tokens change periodically. The agent must update its registration when the OS provides a new token. This is standard mobile practice but needs to be part of the agent-side API (Phase 4).

4. **Protocol-level opt-in**: Should push notifications require protocol authors to opt in (e.g., a `$pushNotification: true` directive), or should they work for all protocols by default with user-level filtering?
   - **Lean: All protocols by default**, with user-level filtering via `preferences.protocols`. Protocol authors shouldn't need to think about push delivery infrastructure.

5. **Encryption-aware notification content**: When a protocol uses `encryptionRequired: true`, the server can't decrypt record data. Should there be a mechanism for protocol authors to specify cleartext "notification hints" that travel alongside encrypted data?
   - This aligns with the `$delivery` proposal's observation that "all routing metadata is cleartext" — notification hints could follow the same pattern.

## Prior Art

| System | Push Model | Lesson |
|---|---|---|
| Matrix | Sygnal push gateway | Separate push gateway service consuming from homeserver events |
| Signal | Sealed sender + push | Data-only push that just wakes the app; content fetched via sealed sender |
| WhatsApp | FCM/APNs data messages | Silent push triggers app wake + E2E encrypted message fetch |
| iMessage | APNs native | Tight OS integration; notification content encrypted to device |
| Mastodon | Web Push (VAPID) | Server-side Web Push with per-user subscription management |

The Signal/WhatsApp pattern (silent push → app wake → encrypted sync) maps most naturally to the "wake-up" notification level combined with the existing sync engine.
