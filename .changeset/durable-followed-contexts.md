---
'@enbox/agent': patch
---

Persist role-authorized foreign contexts as pull-only sources in the existing sync engine, with exact path feeds, encrypted bootstrap, restart recovery, actor-delegate lifecycle fencing, and checkpoints isolated from unrelated identity registration changes. Park invalid bootstrap closures without advancing their checkpoint and retry them through the normal settle cycle.
