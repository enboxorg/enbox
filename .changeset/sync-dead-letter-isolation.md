---
"@enbox/agent": patch
---

fix sync success cleanup so resolving a message for one tenant does not clear another tenant's dead letter for the same CID and remote endpoint
