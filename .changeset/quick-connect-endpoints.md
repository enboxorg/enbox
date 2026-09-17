---
'@enbox/agent': patch
'@enbox/dwn-clients': patch
---

Bound remote DWN endpoint and requester delegate-key discovery during connect approval, and reuse one endpoint snapshot across every phase, so slow DID resolution cannot leave wallets authorizing indefinitely. Reused the shared abort fence for HTTP capability discovery instead of maintaining a second implementation.
