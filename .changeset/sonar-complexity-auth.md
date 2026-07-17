---
"@enbox/auth": patch
---

refactor: reduce cognitive complexity in connect/session functions (Sonar S3776)

Behavior-preserving extract-method refactoring of 7 auth functions flagged for
excessive cognitive complexity (CC 17–34), bringing each to the ≤15 threshold. Each
extraction lifts a contiguous logical unit (a validation pass, a branch handler, a
retry/fallback block) into a named helper called at the exact same point; no
validation/auth/security check was reordered, weakened, or removed, and no error
type/message changed.

- `AuthManager._pollConnectionMonitor` — status-handling and error-handling extracted.
- `connect/lifecycle.ts` `registerSyncScopeForIdentity` / `processDelegateGrantsForExistingIdentity`
  — the shared "register-or-fallback-to-update" and "unregister-tolerating-not-registered"
  blocks factored into helpers (identical error-message checks preserved).
- `connect/status.ts` `computeConnectionStatus` — timestamp resolution, grant grouping,
  newest-group selection, and status derivation extracted.
- `connect/restore.ts` `restoreSession` / `retryOrphanedRevocations` — password resolution,
  retry maintenance, identity resolution, and revocation bookkeeping extracted.
- `registration.ts` `registerWithDwnEndpoints` — token loading, per-endpoint dispatch,
  provider-auth resolution/refresh, and token persistence extracted (CSRF check and the
  nested provider-auth conditionals preserved without inversion).

The worst offender — `auth-manager.ts` `_getConnectionMonitorStatus` (CC 143) — is
intentionally deferred to a dedicated follow-up.

Verified: `@enbox/auth` build + lint clean; all 570 auth tests pass.
