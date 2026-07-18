---
"@enbox/dwn-sdk-js": patch
---

fix: make encryption control repair honor governing protocol history

Stored audience and delivery controls are now replayed against the protocol definition governing their timestamp before newest-role retention is considered. This prevents out-of-order config ingestion from retaining controls that full-history admission would reject, including controls authorized by superseded policy or sealed to a superseded key.
