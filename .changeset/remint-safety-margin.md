---
"@enbox/browser": patch
---

fix(connect): widen the QR re-mint safety margin to 120s so a scanned code survives the wallet unlock ceremony

The relay pointer is single-use with a TTL that starts at mint time, but a
returning-but-locked wallet only dereferences it after the user unlocks. A
30s margin left codes on screen that could die between the scan and the
post-unlock fetch, surfacing as a dead-end 404 in the wallet.
