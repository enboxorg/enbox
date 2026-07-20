---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
---

Make protocol definitions the sole source of record encryption policy and remove caller-controlled encryption switches. Reject records whose stored representation does not match their type policy, prevent used paths from changing representation under the same protocol URI, and separate encrypted `grantKey` records from plaintext `wrappedGrantKey` envelopes in the core encryption protocol.
