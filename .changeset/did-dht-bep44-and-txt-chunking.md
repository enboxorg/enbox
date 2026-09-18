---
"@enbox/dids": patch
---

fix: four `did:dht` wire-format correctness fixes, aligned with the Rust implementation

- enforce the BEP44 1000-byte limit on the value `v` instead of the signing preimage
- chunk DNS TXT record data on UTF-8 byte length at code-point boundaries so multibyte characters are never split across segments
- split TXT record property pairs on the first `=` only, so values containing `=` (e.g. URL query strings, padded base64) are not truncated
- emit authoritative-gateway NS records as the gateway host in FQDN form instead of the full URI, omitting NS records for IP-literal gateways
