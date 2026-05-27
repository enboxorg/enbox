---
"@enbox/agent": patch
---

Fix two sync engine issues:

- **DID propagation retry**: When a newly created `did:dht` identity is hot-added to live sync, the remote DWN may not be able to resolve the DID yet (DHT propagation delay). `initializeLinkTarget` now retries with exponential backoff (2s, 4s, 8s) on DID resolution failures instead of giving up immediately.
- **Push stream reuse**: Buffered push data is now sent as a `Blob` instead of a `ReadableStream`. `Blob` is replayable by `fetchWithRetry`, eliminating `ReadableStream is disturbed` errors on HTTP retry.
