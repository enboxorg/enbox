---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
---

Support exact protocolPath and contextId subtree scope matching for Messages.Read grants. Permission records are now authorized through the protocol scope embedded in each grant record instead of blanket access from a grant scoped directly to the Permissions protocol.
