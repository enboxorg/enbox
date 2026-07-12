---
"@enbox/browser": patch
---

feat(browser): dedupe the expanded wallet grid, unify tile sizing, cap grid height; add Taffy + Astoria

The connect modal's expanded panel now lists only the wallets not already
visible in the identity row, so a wallet is never shown twice and the More
tile's +N count equals the grid size exactly. Grid tiles share the identity
row's tile recipe on a matching four-column grid, the grid caps at three rows
and scrolls in place with a bottom-fade hint that clears at the end of the
list, and the search threshold applies to the grid subset. Taffy and Astoria
join the default wallet catalog.
