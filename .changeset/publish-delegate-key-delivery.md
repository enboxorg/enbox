---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
---

fix: publish delegateKeyDelivery schema and cross-device key delivery

The delegateKeyDelivery field was added to the PermissionGrantData JSON
schema and the agent's connect protocol in commit 2887165, but was not
included in a subsequent publish. This caused a version mismatch where
@enbox/agent@0.6.3 generates grants with delegateKeyDelivery but
@enbox/dwn-sdk-js@0.3.2 rejects them with SchemaValidationAdditionalPropertyNotAllowed.
