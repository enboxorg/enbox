---
"@enbox/dwn-clients": patch
"@enbox/agent": patch
---

fix(sync): honor Retry-After on WebSocket subscription rate limits

A tenant rate limit (429/`TooManyRequests`) on a `MessagesSubscribe`
WebSocket subscription was surfaced as a generic error: the WS transport
discarded the error code and `retryAfterSec`, and the sync engine marked
the link permanently `Failed` with no rate-limit-aware retry — leaving
live sync uninitialized for that target. HTTP requests already honored
`Retry-After`; WebSocket subscriptions now match.

- `web-socket-clients` translates a `TooManyRequests` subscribe error into
  a `RateLimitError` (preserving `retryAfterSec`), mirroring the HTTP
  client; other subscribe errors now surface as `DwnRpcError` with the
  original code/data instead of a bare `Error`.
- `SyncEngineLevel` reschedules live-subscription initialization after the
  server-provided Retry-After window instead of failing the link. Durable
  feed reconciliation continues via the periodic settle check while the
  live subscription is deferred, so no data is lost.
