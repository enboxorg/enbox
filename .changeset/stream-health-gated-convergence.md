---
"@enbox/agent": patch
---

refactor: make browser wake recovery transport-owned

Browser online and visibility signals now stay in the WebSocket transport,
which probes connection health, reconnects, and resumes subscriptions from
their durable cursors. The agent no longer maintains a second wake debounce
and recovery state machine or starts data-plane reconciliation from those
signals. If WebSocket subscriptions cannot operate while HTTP still can, or a
target does not yet have an active link, recovery falls back to the periodic
settle check (the configured sync interval, `5m` by default).

Link connectivity now means transport-observed connectivity rather than the
browser's network hint. While an active page is offline, the default heartbeat
detects the lost socket within one 30-second interval plus its 10-second pong
deadline; a foreground/online wake instead runs the transport's 5-second
on-demand health probe immediately.
