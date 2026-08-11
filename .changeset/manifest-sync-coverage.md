---
"@enbox/api": patch
---

Fail closed when a delegated application's sync registration no longer covers every manifest protocol with read permission, while preserving the auth session for wallet reapproval through `ConnectionStore.refresh()`.
