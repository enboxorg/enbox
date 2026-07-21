---
"@enbox/agent": patch
---

Replace the sync link mailbox, directional queues, and readiness promise with one ordered executor. Wake signals remain coalesced and durable-checkpoint-driven, repair keeps priority without discarding ordinary work, and administrative sync calls abort promptly while a link baseline is unavailable.
