---
"@enbox/auth": patch
---

Preserve current registration credentials across rotations and shared requests, serialize caller-owned persistence callbacks so older work cannot overwrite rotated credentials, fence credential writes and authorization callbacks after teardown, and prepare explicit recovery bootstrap endpoints before publication. Credential erasure cancels captured registrations across managers sharing an agent and waits for started encrypted writes before deleting their credentials, while allowing fresh authorization afterward.
