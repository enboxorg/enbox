---
"@enbox/auth": patch
---

Start initial sync catch-up in the background after auth session state is committed so slow or unavailable DWNs do not delay unlock, connect approval, import, or identity switching.
