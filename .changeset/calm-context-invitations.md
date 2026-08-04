---
"@enbox/api": patch
"@enbox/browser": patch
---

Add protocol-isolated shared-context invitations. Protocols with role groups now include a reserved own-synced inbox, with typed owner invite and recipient list, observe, accept, and dismiss operations. Discovery reads a bounded newest-first page (50 records by default, up to 100); malformed, duplicate, or unsolicited records can crowd out older invitations until continuation and cleanup hardening tracked in #1552. Apps with out-of-band context coordinates can use `contexts.follow()` directly.
