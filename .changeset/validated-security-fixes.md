---
"@enbox/common": patch
"@enbox/dids": patch
"@enbox/crypto": patch
---

fix(security): block SSRF via redirects in did:web/did:dht, reject path traversal in concatenateUrl, fix biased randomPin distribution

- `@enbox/common`: new `isPrivateHostname` / `assertPublicUrl` / `fetchPublicUrl` / `PublicUrlValidationError` helpers; `concatenateUrl` now rejects `..`, `%2F`/`%5C`, malformed percent-encoding, and raw `?`/`#` in the path.
- `@enbox/dids`: new `allowPrivateGatewayUri` option (default `false`) and `DidErrorCode.InvalidGatewayUri`; redirects from Pkarr / did:web are re-validated on every hop.
- `@enbox/crypto`: `randomPin` now uses proper unbiased rejection sampling and enough random bytes for the full digit range.
