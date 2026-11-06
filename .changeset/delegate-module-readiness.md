---
"@enbox/api": patch
---

Treat a duplicate delegated module import as ready only after verifying the active local definition and encryption keys, and return the active local module. This prevents connection readiness from rejecting configurations already imported by bootstrap or sync.
