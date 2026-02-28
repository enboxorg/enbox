---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/auth": patch
"@enbox/browser": patch
"@enbox/crypto": patch
"@enbox/dwn-server": patch
---

Update remaining Web5 references in JSDoc, comments, and package metadata to Enbox

- Replace ~60 stale "Web5" references in JSDoc/comments across agent, api, auth, browser, crypto, and dwn-server packages
- Update package.json descriptions for @enbox/crypto and @enbox/browser
- Fix typo in dwn-server http-api.ts ("am enbox" → "an enbox")
- Update code examples in @enbox/auth to use `Enbox.connect()` instead of `new Web5()`
