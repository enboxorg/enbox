---
"@enbox/agent": patch
"@enbox/api": patch
---

fix: republish with resolved workspace dependencies

The previous releases of @enbox/agent@0.1.0 and @enbox/api@0.0.3 contained
literal `workspace:*` strings in their published dependencies, making them
uninstallable outside the monorepo. This patch release uses `bun publish`
which correctly resolves workspace references to actual version numbers.
