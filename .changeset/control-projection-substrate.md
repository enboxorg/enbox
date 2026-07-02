---
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-sql-store": patch
---

Add replication index projection for encryption control capability domains.

Stores that already contain source-protocol `$encryption/*` control records should be reprovisioned when adopting this substrate.
