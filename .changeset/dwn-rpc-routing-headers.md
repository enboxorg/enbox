---
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
---

feat(dwn-clients, dwn-server): project DWN routing fields into server-validated `dwn-*` request headers, frame data-bearing replies in the response body with a `dwn-status` header, and read records whose tags hold text outside ISO-8859-1
