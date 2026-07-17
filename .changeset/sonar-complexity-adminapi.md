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

Verified: dwn-server build + lint clean; all 264 admin tests pass (incl. admin-api
routing tests).
