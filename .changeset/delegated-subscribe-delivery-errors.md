---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sdk-js": patch
---

Close delegated MessagesSubscribe streams when invoked grants become invalid during delivery, and keep subscription resume checkpoints monotonic.
