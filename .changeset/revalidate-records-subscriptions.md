---
"@enbox/dwn-sdk-js": patch
---

Fix `RecordsSubscribe` authorization lifetime. Open subscriptions now re-fetch
referenced Records.Read grants and revalidate embedded author-delegate grants and
protocol-role membership before each matching event is delivered. A deleted,
revoked, or expired referenced grant, or a removed role assignment, closes the subscription with
`RecordsSubscribeDeliveryAuthorizationFailed`; a transient non-DWN revalidation
failure closes it with the retryable `RecordsSubscribeDeliveryFailed` code.
