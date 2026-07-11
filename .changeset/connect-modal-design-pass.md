---
'@enbox/browser': patch
---

Connect modal design pass: the wallet switcher becomes a square tile grid with a search bar past one row, the footer collapses to a single row, and the whole surface tightens vertically. The modal now follows the visitor's system light/dark appearance live, and apps can pass an optional `theme` (forced appearance, brand accent, per-scheme palette tokens). Also repairs a stylesheet nesting slip that left the wallet panel permanently expanded and the phone-connected pulse unstyled.
