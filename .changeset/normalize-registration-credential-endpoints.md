---
"@enbox/auth": patch
"@enbox/dids": patch
---

Normalize saved and caller-managed registration credential endpoint URLs consistently with registration requests, including stable, linear-time normalization of repeated trailing slashes. Reject conflicting credentials for the same normalized endpoint before authorization or network requests.
