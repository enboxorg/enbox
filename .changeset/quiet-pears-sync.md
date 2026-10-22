---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
---

fix: bind point-read payloads to their requested message and release unused admission streams

Abort the owning HTTP request when its response stream is cancelled or fails, so sync cleanup releases the remote response under Bun as well as the local reader.
