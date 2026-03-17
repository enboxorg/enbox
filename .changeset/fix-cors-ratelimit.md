---
"@enbox/dwn-server": patch
---

fix(dwn-server): include CORS headers on per-IP rate-limit 429 responses

The per-IP rate limiter returned 429 without CORS headers because it fired
before the CORS middleware. Browsers treated the response as a CORS error
instead of a rate-limit error, making it impossible for clients to read the
Retry-After header or the error body.
