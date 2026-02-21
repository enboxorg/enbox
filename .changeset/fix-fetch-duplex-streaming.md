---
'@enbox/dwn-clients': patch
---

fix: add `duplex: 'half'` to streaming fetch requests for browser compatibility

Browsers require `duplex: 'half'` in the `RequestInit` options when the request
body is a `ReadableStream`. Without it, the sync-push path (which sends record
data as a raw stream) fails with:
"The `duplex` member must be specified for a request with a streaming body".
