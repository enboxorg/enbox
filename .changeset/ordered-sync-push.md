---
"@enbox/agent": major
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
---

Route sync push through remote replicated admission and use `ReplicationApplyResult` as the source of truth for push success, dependency fetching, retry, and terminal dead-letter classification.

Remote DWNs must run a server version exposing `dwn.applyReplicatedMessage` before publishing this agent package.
