---
"@enbox/dwn-server": patch
"@enbox/api": patch
---

fix: end the shared Postgres pool exactly once during graceful shutdown and validate/retry typed protocol auto-configuration
