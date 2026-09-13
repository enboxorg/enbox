---
'@enbox/dwn-sdk-js': patch
---

Classify a tombstoned parent as a terminal error (`ProtocolAuthorizationParentRecordDeleted`) instead of a repairable missing dependency. Replication now marks such a write `Invalid` rather than retrying a dependency that can never be repaired. A parent that has merely not arrived yet remains `Incomplete`.
