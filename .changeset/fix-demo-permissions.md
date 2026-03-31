---
"@enbox/agent": patch
"@enbox/auth": patch
---

fix: add delete to default connect permissions and quiet singleton push warnings

Adds `'delete'` to `DEFAULT_PERMISSIONS` in `@enbox/auth` so apps using
bare protocol definitions in `auth.connect()` get `Records.Delete` grants
by default. Downgrades `RecordLimitExceeded` sync push warnings to debug
level in `@enbox/agent` — these are expected in multi-device singleton
convergence scenarios.
