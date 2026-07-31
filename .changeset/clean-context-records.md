---
'@enbox/api': patch
'@enbox/browser': patch
---

Expose shared records through a context-bound type that hides tenant routing, protocol roles, delivery controls, and raw record mutation options while defaulting direct singleton writes to the accepted context.
