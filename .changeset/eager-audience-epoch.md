---
"@enbox/agent": patch
---

feat(agent): add `AgentDwnApi.provisionRoleAudienceEpoch` to eagerly provision a role-audience epoch for a `(protocol, contextId, role)` without adding a member. Mints + persists the audience keypair and writes the public `audienceEpoch` record (idempotent; reused by later member-adds), so records for a role can carry a `roleAudience` entry before any member of that role exists.
