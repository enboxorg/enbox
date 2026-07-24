---
"@enbox/api": patch
"@enbox/browser": patch
---

Return application values from protocol-scoped record operations and throw `DwnResponseError` for non-success DWN replies, except that a missing read returns `undefined`. Record updates and patches now return the same canonical record handle, while successful delete, store, import, and send commands resolve without a response envelope. Raw record response types and role-audience delivery outcomes remain available from `@enbox/api/advanced`; the high-level exports no longer include those response types or `isOk`.
