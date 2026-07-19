---
"@enbox/agent": patch
"@enbox/auth": patch
---

refactor: the sync engine is live-only — poll mode removed. startSync starts live sync; `interval` now sets the periodic settle-check cadence. Userland polling remains trivial via the public one-shot sync(): setInterval(() => agent.sync.sync(), ms).
