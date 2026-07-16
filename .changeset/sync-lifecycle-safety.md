---
"@enbox/agent": patch
---

make sync lifecycle transitions stop their timers and wait for active sync work before clearing or closing storage, while tolerating expected dead-letter cleanup races during teardown
