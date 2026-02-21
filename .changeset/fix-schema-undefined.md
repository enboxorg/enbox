---
"@enbox/api": patch
---

Fix TypedWeb5 injecting `schema: undefined` into DWN filters for protocol types that only define `dataFormats` (no `schema`). This caused the DWN SDK's RecordsFilter validation to fail silently, hanging wallet loading for protocols like ProfileProtocol whose `avatar`/`hero` types have no schema.
