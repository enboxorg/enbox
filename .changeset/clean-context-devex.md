---
'@enbox/api': patch
'@enbox/browser': patch
---

Expose owned and member contexts through one live catalog. Member contexts provide `refresh()` for bounded replica catch-up, and context establishment failures retain their causes.
