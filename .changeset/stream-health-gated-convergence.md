---
"@enbox/agent": patch
---

refactor: make browser wake recovery transport-owned

Browser online and visibility signals now stay in the WebSocket transport,
which probes connection health, reconnects, and resumes subscriptions from
their durable cursors. The agent no longer maintains a second wake debounce
and recovery state machine or starts data-plane reconciliation from those
signals. Periodic settle checks remain responsible for full verification.
