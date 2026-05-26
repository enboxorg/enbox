---
"@enbox/auth": patch
---

Seed phrase recovery now happens automatically inside `vaultConnect()` and `importFromPhrase()`. When a recovery phrase is provided and no identities exist locally, the SDK pulls identity metadata, keys, and profile data from the remote DWN in a two-phase sequence. Wallets no longer need to manually orchestrate stop/pull/register/pull/push/restart after connecting with a recovery phrase.
