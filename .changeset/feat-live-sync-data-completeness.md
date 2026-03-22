---
"@enbox/dwn-sdk-js": minor
"@enbox/agent": patch
---

feat(dwn-sdk-js): include encodedData in EventLog emit for live sync

fix(agent): handle inline encodedData in live pull and fetch data for large records

Three changes that make live WebSocket sync deliver complete records:

1. RecordsWriteHandler now emits `messageWithOptionalEncodedData` (with
   inline `encodedData` for records <= 30 KB) to the EventLog instead of
   the raw message. WebSocket subscribers receive complete small records
   without a separate MessagesRead round-trip.

2. The sync engine's `extractDataStream` now decodes inline `encodedData`
   from WebSocket events into a ReadableStream. For large records (no
   inline data), it fetches the data from the remote DWN via MessagesRead
   before storing locally.

3. RecordsWriteHandler now allows re-processing of the same message when
   the existing copy was stored as an incomplete initial write (204, no
   data) and the incoming message supplies data. This repairs records
   that were previously "poisoned" by live sync storing them without data.

4. MessagesSyncHandler diff inline threshold lowered from 256 KB to 30 KB
   to match the MessageStore's encodedData threshold, keeping diff
   responses lightweight.
