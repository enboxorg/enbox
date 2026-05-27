---
"@enbox/agent": patch
"@enbox/auth": patch
---

Fix three sync issues that caused cascading errors during identity creation and seed phrase recovery:

- **Push retry for protocol dependencies**: Protocol dependency 400 errors (`ComposedProtocolNotInstalled`, `ProtocolNotFound`) are now classified as transient and retried instead of permanently dead-lettered. This makes out-of-order protocol pushes self-healing.
- **Push stream buffering**: `pushMessages()` now buffers data streams before sending, preventing `ReadableStream is disturbed` errors when the underlying HTTP fetch retries.
- **Recovery KeyDeliveryProtocol**: `recoverIdentitiesFromRemote()` installs the KeyDeliveryProtocol for the agent DID before the first sync pull, so encrypted JwkProtocol records (private keys) can be committed by the closure resolver.
