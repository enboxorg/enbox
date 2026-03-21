---
"@enbox/agent": patch
---

fix(agent): propagate permission errors in live sync subscription setup

openLivePullSubscription and openLocalPushSubscription were silently
returning when the delegate permission grant lookup failed, causing live
WebSocket sync to silently do nothing. Errors now propagate to the
startLiveSync catch block so they are visible in the console.
