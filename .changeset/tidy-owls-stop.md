---
'@enbox/auth': patch
---

Make password-provider fallback explicit so cancellation and real authorization failures stop instead of being hidden by another provider.
