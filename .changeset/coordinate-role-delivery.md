---
'@enbox/agent': patch
'@enbox/api': patch
---

Run role-audience delivery reconciliation and bounded transient retries in the background for each encrypted-role protocol used by an Enbox session. Work waits for a current reachable replica and wakes on startup, relevant role changes, connectivity recovery, and recipient protocol installation without delaying connection readiness or accepted writes.
