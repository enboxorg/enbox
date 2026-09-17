---
'@enbox/agent': patch
---

Bound remote DWN endpoint and requester delegate-key discovery during connect approval, and reuse one endpoint snapshot across every phase, so slow DID resolution cannot leave wallets authorizing indefinitely.
