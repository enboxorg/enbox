---
'@enbox/dwn-sdk-js': patch
---

Classify a tombstoned parent as terminal during replication apply, instead of a repairable missing dependency. The client-facing reply is unchanged — it returns the same missing-parent error as a parent that has not arrived yet — while the receiver, which can see the local tombstone, marks the write `Invalid` rather than retrying a dependency that can never be repaired. A parent that has merely not arrived yet remains `Incomplete`.
