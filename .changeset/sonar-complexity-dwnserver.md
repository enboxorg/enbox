---
"@enbox/dwn-server": patch
---

refactor: reduce cognitive complexity in server routing/admin (Sonar S3776)

Behavior-preserving extract-method refactoring of 6 functions (CC 16–39) to the ≤15
threshold: the connect-route dispatcher (`#matchConnectRoutes`), server setup
(`#setupServer`), delivery-target resolution, the JSON-RPC process-message handler,
and the admin tenant-list / config-patch handlers. Extracted route/validation helpers
return `Response | null` (or `T | Response`) with the route guard as their first
statement — no side effect runs before a route matches, and all status codes, error
bodies, checks, and evaluation order are preserved verbatim.

Defers the monster functions `admin/admin-api.ts:167` (CC 76),
`delivery-service.ts:547` (CC 48), and `http-api.ts:389` (CC 43).

Verified: dwn-server build + lint clean; server test suite runs in CI.
