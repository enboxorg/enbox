---
"@enbox/dwn-sdk-js": patch
---

Use one Records collection pipeline for Query, Count, and Subscribe authorization and visibility planning. Query and Subscribe snapshots now also share one projected-page executor, keeping record-limit occupancy, audience projection, control-record visibility, pagination refill, and default ordering in one implementation.

Remove the superseded `Records.buildUnpublishedControlRecordsFilter()`, `Records.shouldProtocolAuthorize()`, `Records.shouldBuildUnpublishedAuthorFilter()`, and `Records.shouldBuildUnpublishedRecipientFilter()` helpers.
