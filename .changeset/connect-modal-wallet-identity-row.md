---
"@enbox/browser": patch
---

feat(browser): wallet identity row and QR-centre wallet logo in the connect modal

The footer's text-only wallet disclosure becomes a "Connecting with" row of
wallet tiles — the selected wallet plus the next catalog wallets (never
repeating one), with a More tile that expands the full searchable catalog and
custom-URL entry in place and collapses back on selection. The selected
wallet's mark is centred on the QR (well within ECC-M's recovery budget) and
named in the stage copy, and the mobile deep link reads "Continue in
{wallet}".
