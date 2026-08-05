---
'@enbox/api': patch
'@enbox/browser': patch
---

Bound and make initial context record subscription handoff cancellable so sustained live writes cannot keep opening the stream pending, while releasing each per-operation cancellation listener as the opening replay advances.
