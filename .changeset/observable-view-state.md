---
'@enbox/api': patch
'@enbox/browser': patch
---

Name observable record and context results as view state: `RecordViewState` and `ContextViewState` expose a `status` discriminator, while their views provide `getState()` and publish the same state through `subscribe()`.
