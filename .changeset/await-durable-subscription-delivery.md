---
"@enbox/dwn-sdk-js": patch
"@enbox/browser": patch
"@enbox/dwn-server": patch
---

Await durable subscription listeners before advancing cursors, ending replay, or starting live delivery, and report progress-gap notification failures. Pin delivered tokens to their read page's generation and preserve queued wakes across delivery failures with paced retries. Add local subscription cancellation through DWN execution and close pending replay and late handles when a WebSocket disconnects. Cursor subscriptions finish opening after their replay listeners complete; replay listeners must not await the returned subscription handle. Popup launches remain synchronous within clicks and explicitly detach the internally handled connect session.
