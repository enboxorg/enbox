---
"@enbox/dwn-server": patch
---

refactor: reduce cognitive complexity of the admin-API router (Sonar S3776)

Behavior-preserving decomposition of `AdminApi.route` (was CC 76) to ≤15 via a
two-level dispatch: `route` keeps the `/admin/api` prefix strip, the unauthenticated
passkey-login checks, the `validateAdminAuth` gate/audit/401 handling, and the
try/catch, then delegates the authenticated dispatch to `#dispatchAuthenticatedRoutes`,
which calls seven cohesive `#match*Routes` helpers in the EXACT original top-to-bottom
order and ends with the original 404. Every route check is byte-identical and in its
original relative position — no route was hoisted, reordered, weakened, or dropped, and
the per-route auth-method (403) checks are preserved verbatim.

The dispatcher and matchers are synchronous and return matched handlers as unawaited
promises, so the original error-handling contract is preserved exactly: errors thrown
synchronously while matching are still caught by `route` (JSON 500), while async handler
rejections still propagate to `HttpApi` (plain-text 500 + method/path logging) rather
than being swallowed into AdminApi's JSON 500. A regression test covers this contract.

Verified: dwn-server build + lint clean; all 265 admin tests pass (incl. admin-api
routing + the async-error-contract test).
