---
"@enbox/agent": patch
---

Replace the sync link mailbox, directional queues, and readiness promise with one ordered executor. Wake signals remain coalesced and durable-checkpoint-driven, repair keeps priority without discarding ordinary work, and administrative sync calls abort promptly while a link baseline is unavailable.

Repair attempts superseded by a newer repair signal are retired from the bounded failure count, so later genuine failures retain the complete retry ladder and their reported attempt number may restart after supersession.
