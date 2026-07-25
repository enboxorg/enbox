---
"@enbox/dwn-clients": patch
"@enbox/dwn-server": patch
"@enbox/dwn-server-admin-ui": patch
---

fix: bound RecordsWrite data at server ingress

Ordinary and replicated HTTP writes now share one stream cap that cancels input as soon as it exceeds the signed `descriptor.dataSize`. The server also rejects a declared record-data size above `maxRecordDataSize` before DWN processing and configures Bun's request-body ceiling with the required body-v1 framing overhead.

`maxRecordDataSize` is now startup-only because the HTTP and WebSocket transport ceilings are established when the server starts. Configure it with `MAX_RECORD_DATA_SIZE` and restart the server rather than changing it through the runtime admin endpoint. Metadata-only writes may continue referencing previously stored data above a subsequently lowered limit.
