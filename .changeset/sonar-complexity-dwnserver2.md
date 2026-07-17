---
"@enbox/dwn-server": patch
---

refactor: reduce cognitive complexity of the HTTP router and DWN-endpoint extractor (Sonar S3776)

Behavior-preserving extract-method refactoring of two large functions to ≤15:

- `#route` (was CC 43) — the main HTTP router, split into per-group matchers
  (`#matchStaticRoutes`, `#matchLocalNodeConvenienceRoutes`, `#matchAdminRoutes`,
  `#matchProviderAuthRoutes`, plus `#handleMetrics`) that return `Response | null`;
  `#route` dispatches with `if (result) return result;`, preserving the exact match
  order and fall-through so every request maps to the same handler and status code.
- `#extractDwnEndpoints` (was CC 48) — split the per-service / array / object
  `serviceEndpoint` parsing into helpers, deduplicating the map-entry construction,
  preserving the exact accept/reject rules and the `nodes`-before-`url` endpoint order.

Boolean transforms are single-condition/compound negations (exact by double-negation),
not De Morgan distributions. No check reordered/weakened; no status code or response body changed.

Verified: dwn-server build + lint clean; delivery-service + http-api test suites pass
(127 tests, directly covering both functions).
