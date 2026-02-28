---
"@enbox/auth": patch
---

Add LevelDB-backed `LevelStorage` adapter as the default storage for Node/CLI environments, replacing the in-memory fallback that lost session data on process exit.
