---
"@enbox/agent": patch
---

fix: add safe, deadline-bounded sync teardown and identity lifecycle waits

The existing `stopSync()` numeric timeout keeps its legacy coercion for
non-finite values, but its default two-second budget now also bounds transport
subscription closure. The new lifecycle option objects reject invalid timeout
values before changing state.

Stopping invalidates callbacks and clears in-memory runtime ownership before
closing remote and local subscriptions concurrently. An unfinished transport
close remains tracked across retries, so a later lifecycle call cannot report
success until the original cleanup settles.
