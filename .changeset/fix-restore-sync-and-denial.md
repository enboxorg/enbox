---
"@enbox/auth": patch
---

fix: restore path updates stale sync registration, handle QR connect denial

- Session restore now derives the protocol list from stored grants and
  updates the sync registration before starting sync. This fixes stale
  `protocols: []` (global sync) registrations from prior sessions that
  caused the sync engine to attempt the permissions protocol and fail.
- WalletConnect.initClient recognizes `DENIED` token from the relay
  callback, returning undefined immediately instead of prompting for PIN.
- Updated denial error message to "Connection was denied by the wallet."
