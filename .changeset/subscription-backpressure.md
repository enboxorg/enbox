---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sdk-js": patch
"@enbox/browser": patch
---

fix: lossless subscription-decrypt backpressure with acks gated on consumer completion

The decrypting subscription wrapper returns each event's completion promise — now covering decryption AND the consumer's own (possibly async) processing — and the WebSocket client acks each event, and advances its reconnect cursor, only after that completion resolves, in delivery order. If more than 256 events queue behind in-flight decryption the wrapper terminates losslessly: the overflowing and all later events reject with the new `SubscriptionHandlerTerminalError`, which the WebSocket transport honors by closing the tracked subscription and withholding their acks and cursor advancement, while the consumer receives a synthetic `SubscriptionDecryptBackpressureExceeded` error carrying the last successfully delivered cursor — resubscribing from it replays every dropped event. `SubscriptionListener` and `DwnSubscriptionHandler` now explicitly permit `void | Promise<void>`, and every handler invocation — event delivery and transport lifecycle notifications alike — is normalized through a promise chain: a synchronous throw becomes an observed rejection instead of escaping the socket dispatch or skipping other subscriptions' notifications. `@enbox/browser` also re-exports `AudienceDecryptError`, `AudienceDecryptFailureCause`, and `AudienceKeyDeliveryOutcome` so browser-only apps can classify decrypt failures and delivery outcomes without importing `@enbox/api` directly.
