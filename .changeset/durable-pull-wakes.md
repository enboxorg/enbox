---
"@enbox/agent": patch
---

refactor: treat remote subscription events as cursorless durable pull wakes

Pull and push subscriptions now have the same progress model: their events only coalesce work, while `MessagesQuery` resumes from the persisted direction checkpoint and advances it after a settled page. Matching subscription snapshots establish a paired startup baseline; reconnect wakes both durable directions to cover the disconnected interval. Pull admission reuses message and inline-data bytes returned by the durable query, verifies immediate push echoes against local stored state before avoiding remote hydration, and emits one described `delivery:applied` event for each fresh root or dependency. Event cursors, EOSE commits, subscription-gap repair state, and the separate live-pull admission pipeline are removed.
