---
"@enbox/api": patch
---

fix: republish with correct @enbox/agent@0.1.1 dependency

Previous attempts resolved workspace:* to @enbox/agent@0.1.0 because bun
kept the stale lockfile resolution. This release regenerates the lockfile
from scratch so workspace:* correctly resolves to @enbox/agent@0.1.1.
