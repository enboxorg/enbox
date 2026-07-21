---
"@enbox/common": patch
"@enbox/dwn-sdk-js": patch
---

fix browser message-store writes so tabs, workers, and service workers sharing one IndexedDB database cannot assign the same replication-log position or overwrite each other's fingerprints
