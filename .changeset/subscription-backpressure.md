---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
"@enbox/browser": patch
---

fix: bound the subscription-decrypt queue and gate flow-control acks on handler completion

The decrypting subscription wrapper now returns each event's completion promise and terminates the subscription with a synthetic `SubscriptionDecryptBackpressureExceeded` error (resubscribe-from-cursor replays the gap) if more than 256 events queue behind in-flight decryption; the WebSocket client acks each event only after its handler resolves, in arrival order, so a fast server can no longer outrun slow processing and accumulate unbounded ciphertext client-side. `@enbox/browser` also re-exports `AudienceDecryptError`, `AudienceDecryptFailureCause`, and `AudienceKeyDeliveryOutcome` so browser-only apps can classify decrypt failures and delivery outcomes without importing `@enbox/api` directly.
