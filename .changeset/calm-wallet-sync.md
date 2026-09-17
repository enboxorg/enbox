---
"@enbox/auth": patch
---

Start initial sync catch-up in the background after auth session state is committed so slow or unavailable DWNs do not delay session restore, vault setup, portable import, delegated connect finalization, or identity switching. Background startup is session-owned so a later lock still stops a startup that outlives its session.
