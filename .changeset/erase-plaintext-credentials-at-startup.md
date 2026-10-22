---
"@enbox/auth": patch
---

Erase old plaintext registration credentials when creating the auth manager, including for locked vaults without registration enabled. Remove registration-only storage plumbing; encrypted credentials are not read or changed by this best-effort cleanup.
