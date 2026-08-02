---
'@enbox/agent': patch
'@enbox/api': patch
'@enbox/browser': patch
'@enbox/dwn-sdk-js': patch
---

Use the standard `RecordView` for live membership and invitation collections; read their items from `state.records`. Centralize shared-context role scope and bootstrap validation while removing redundant projections and response metadata.
