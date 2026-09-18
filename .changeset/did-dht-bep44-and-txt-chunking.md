---
"@enbox/dids": patch
---

fix: enforce the BEP44 1000-byte limit on the value `v` instead of the signing preimage, and chunk DNS TXT record data on UTF-8 byte length at code-point boundaries so multibyte characters are never split across segments
