---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/browser': patch
'@enbox/dwn-sdk-js': patch
---

Follow foreign contexts through ordered role groups, persist only their role names for restart recovery, and derive active replication paths from the hosted protocol definition. Same-URI path-policy changes create a new fenced acceptance, stale handles fail with `ContextRetiredError`, unavailable replication fails with `ContextNotReadyError` instead of waiting forever, and role-feed dead letters pause replication before it reports current.

Role-action path enumeration now uses locale-independent code-unit ordering.
