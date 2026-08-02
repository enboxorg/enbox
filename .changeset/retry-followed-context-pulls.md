---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/browser': patch
---

Keep temporarily unadmittable role-feed entries retryable instead of permanently dead-lettering them after 24 hours. Member context readiness now pulls only the accepted context from each source endpoint and succeeds in a stopped runtime only when every exact feed drains.
