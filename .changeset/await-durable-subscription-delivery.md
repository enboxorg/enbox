---
"@enbox/dwn-sdk-js": patch
"@enbox/browser": patch
"@enbox/dwn-server": patch
---

Await durable subscription listeners before advancing cursors, ending replay, or starting live delivery, and report progress-gap notification failures. Pin delivered tokens to their read page's generation and preserve queued wakes across delivery failures with paced retries. Retire replaced event-log drains and own pending WebSocket subscriptions before replay, preserving ACK controllers on duplicate IDs and cancelling on overflow, unsubscribe, or disconnect. Pause producers only at the existing socket buffer limit, resuming on ACK or cancelling on close and after a 30-second ACK deadline. Fence late handles and cleanup when IDs are reused, and finish socket teardown if a subscription close fails. Cursor subscriptions finish opening after their replay listeners complete; replay listeners must not await the returned subscription handle. Popup launches remain synchronous within clicks and explicitly detach the internally handled connect session.
