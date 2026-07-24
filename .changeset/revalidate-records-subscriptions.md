---
"@enbox/dwn-sdk-js": patch
---

Fix `RecordsSubscribe` authorization lifetime. Open subscriptions now revalidate
invoked Records.Read grants, embedded author-delegate grants, and protocol-role
membership before each matching event is delivered. Revoked, expired, or missing
authority closes the subscription with
`RecordsSubscribeDeliveryAuthorizationFailed`; a transient non-DWN revalidation
failure closes it with the retryable `RecordsSubscribeDeliveryFailed` code.
