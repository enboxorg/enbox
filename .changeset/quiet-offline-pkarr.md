---
"@enbox/common": patch
"@enbox/dids": patch
"@enbox/dwn-clients": patch
---

Skip DID-DHT Pkarr reads while a browser explicitly reports that it is offline, return a machine-readable transient resolution cause without caching the failure, and share the negative connectivity hint with WebSocket transport.
