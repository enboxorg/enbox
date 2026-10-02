---
"@enbox/dwn-sdk-js": patch
"@enbox/browser": patch
---

Await durable subscription listeners before advancing cursors, ending replay, or starting live delivery, and report progress-gap notification failures. Derive the stable tenant stream ID once per subscription while retaining fresh store epochs. Cursor subscriptions now finish opening after their replay listeners complete; replay listeners must not await the returned subscription handle. Popup launches remain synchronous within clicks and explicitly detach the internally handled connect session.
