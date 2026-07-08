---
"@enbox/dwn-server": patch
---

fix: forward record data with DeliveryService messages

Endpoint forwarding and `$delivery: 'direct'` participant delivery previously POSTed data-bearing `RecordsWrite` messages with an empty body, so receiving DWNs only ever got metadata. `DeliveryService` now reads the record data back from the source tenant's stores (`encodedData` for small records, the data store for large ones) and sends it as the `application/octet-stream` request body.
