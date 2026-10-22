---
"@enbox/agent": patch
"@enbox/auth": patch
---

Prepare explicit vault recovery bootstrap tenants before publishing their endpoints or pulling recovery data. Keep failed bootstraps unpublished and require an explicit phrase-restore retry before an ordinary vault connection can commit a session. Add native recovery-bootstrap deferral while preserving standalone vault publication and established recovery routes.

Retain generated owner recovery phrases and required registration policy inside the encrypted vault record until setup and session persistence succeed. Resume failed agent or identity tenant preparation on retry, and reject ordinary session restoration while owner setup or recovery publication remains incomplete. Read current encrypted vault state when checking or completing setup across contexts.
