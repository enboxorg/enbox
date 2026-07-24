---
"@enbox/dwn-sdk-js": patch
---

Fix `RecordsSubscribe` authorization lifetime. Open subscriptions now revalidate
invoked Records.Read grants, embedded author-delegate grants, and protocol-role
membership before each matching event is delivered. Revocation, expiry, or role
deletion emits one terminal authorization error and closes the subscription.
