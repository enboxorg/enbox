---
"@enbox/agent": patch
---

Persist an internal, reconstructable audience-key delivery projection for locally accepted role records so initial delivery outcomes survive agent restarts without becoming a second membership authority. This is the storage foundation for role-record reconciliation and restart-safe retry tracked by #1092.
