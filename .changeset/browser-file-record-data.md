---
"@enbox/api": patch
---

Accept browser File data directly in record writes and updates, preserving its bytes and MIME type even when an explicit data format is supplied. Normalize cross-window Blob/File inputs once so native record consumers can use them as local Blobs.
