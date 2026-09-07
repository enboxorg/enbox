---
"@enbox/dwn-sdk-js": patch
---

fix: select broad RecordsRead top-1 from the readable, occupied population

A broad `RecordsRead` now walks the ordered candidates in pages of 25 and
returns the first record the requester may read that is also a current
`$recordLimit` occupant, instead of checking only the raw top-1 match. A
hidden record can therefore no longer shadow a readable match with a false
404/401. Exact-`recordId` reads keep their 401/404 shape, and authorized
tombstones still return their 404-with-delete reply. Broad reads with no
readable match now return a bare 404 rather than 401, matching
`RecordsQuery` visibility semantics.
