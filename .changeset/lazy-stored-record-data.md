---
"@enbox/agent": patch
"@enbox/api": patch
---

Keep low-level record reads, queries, subscriptions, and writes on the raw bytes stored by the DWN, and lazily decrypt the application view from each RecordsWrite encryption envelope. Decryption failures now surface when `record.data` is consumed instead of failing the containing read, query, or subscription.
