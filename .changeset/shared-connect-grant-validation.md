---
"@enbox/auth": patch
"@enbox/cli": patch
---

fix: validate connect grants (grantee, scope subset) in the shared connect path for every transport

The grantee-matches-delegate and granted-scopes-subset checks lived in the CLI handler only, so browser popup and direct relay connects imported whatever a wallet returned. The validation now runs in AuthManager's handler flow and in walletConnect, and @enbox/cli drops its private copy.
