---
"@enbox/agent": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
---

fix(replication): move negotiated HTTP RPC envelopes into a streaming request body and stop replaying dependencies the remote has already acknowledged

HTTP clients now negotiate `body-v1` through the server's `/info` response. Supporting peers send the JSON-RPC envelope and optional raw record data in one length-prefixed, streaming body, avoiding proxy header limits without buffering or base64-expanding large attachments. Older servers continue to receive the legacy `dwn-request` header format.

The agent now treats `Applied`, `Duplicate`, and `Superseded` dependency results as acknowledgements. If a root continues to report only acknowledged dependencies as missing, it is handed to delayed reconciliation instead of consuming the admission pass budget and immediate retry ladder.
