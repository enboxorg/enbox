---
"@enbox/api": patch
---

fix: republish with correct @enbox/agent dependency version

The previous @enbox/api@0.0.4 was published with a dependency on
@enbox/agent@0.1.0 (which has broken workspace:* references) instead of
@enbox/agent@0.1.1. This happened because the lockfile was stale when
bun pm pack resolved the workspace:* reference.

The release workflow now regenerates the lockfile after version bumps
to prevent this from recurring.
