---
"@enbox/agent": minor
"@enbox/api": minor
"@enbox/browser": minor
---

Expose the connected identity's aggregate sync currentness, connectivity, and
latest engine-recorded activity through the existing framework-neutral
connection snapshot. Status is driven by local sync state and existing events,
uses the agent's canonical connectivity aggregation, and fences session
replacement and teardown without notifying listeners during disposal.
