---
"@enbox/agent": patch
"@enbox/api": patch
"@enbox/dwn-sdk-js": patch
"@enbox/dwn-server": patch
---

Bound query work by applying a default page size of 100, a maximum page size of 1,000, and a maximum of 100 filter or permission-grant values. Empty Records author and recipient arrays are now rejected instead of being treated as an omitted filter, sync rejects scopes that cannot be represented by one bounded Messages request, and internal workflows that require complete collections now follow pagination cursors explicitly. Security-sensitive record collections and remote permission catalogs fail without returning partial results after 10 pages or 1,000 entries.
