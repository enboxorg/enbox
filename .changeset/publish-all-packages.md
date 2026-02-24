---
"@enbox/dwn-sdk-js": minor
"@enbox/agent": minor
"@enbox/api": minor
"@enbox/common": patch
"@enbox/dids": patch
"@enbox/browser": minor
"@enbox/dwn-clients": patch
"@enbox/dwn-sql-store": patch
---

feat: $squash protocol directive, live sync engine, record delivery, security hardening

- dwn-sdk-js: add $squash protocol directive for RecordsWrite, record delivery and endpoint forwarding
- agent: live sync engine with real-time subscriptions and connectivity awareness
- api: live sync engine integration
- common: escape LIKE wildcards, remove Math.random from public API
- dids: add fetch timeouts and SSRF protection for did:web resolution
- browser: add deactivatePolyfills, clearDrlCache, configurable resolvers, strict TypeScript mode
- dwn-clients: properly signal rate limiting to clients
- dwn-sql-store: add squash column migration and message store adjustments
