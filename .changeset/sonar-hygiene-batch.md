---
"@enbox/agent": patch
"@enbox/browser": patch
"@enbox/common": patch
"@enbox/crypto": patch
"@enbox/dids": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
"@enbox/dwn-server-admin-ui": patch
"@enbox/dwn-sql-store": patch
---

chore: resolve SonarCloud type/class-hygiene and test-quality findings

Behavior-preserving cleanup (no functional changes):

- **readonly** on public static / constructor-only members (S1444, S2933)
- **named type aliases** for repeated inline unions (S4323)
- **more specific test assertions** — `toBeInstanceOf` / `toBeNull` / `toHaveLength` (S5906)
- merged identical conditional branches (S1871), `String.raw` (S7780), `.dataset` /
  `.remove()` DOM APIs (S7761/S7762), class-field init (S7757), `self`→lexical-`this`
  arrow closures (S7740), removed redundant `| undefined` (S4782), removed an
  unnecessary regex escape (S6535), documented intentional no-op methods (S1186),
  nested-template extraction (S4624), and a `role="button"` span → real `<button>`
  in the admin UI (S6819).

Redundant-type-alias findings (S6564) on exported public API types, duplicated-code
findings (S4144) needing design judgment, deprecated-API swaps without a drop-in
replacement (S1874), and a few tests needing author intent were deliberately left
for follow-up rather than risk breaking API or behavior.
