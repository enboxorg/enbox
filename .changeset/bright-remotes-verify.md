---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
---

Authenticate protocol configurations used for remote encryption-policy resolution and record artifacts returned through app-facing remote query and read calls, bind record results to the original request filter, and verify inline or streamed record bytes against their signed CID and size. Remote protocol definitions used for encryption policy must now be signed directly by the target DID. Anonymous subscriptions now use the current transport request shape, and lazy read-only records reject data from a different record version.

These checks authenticate returned artifacts; they do not prove result completeness or freshness because DWN query replies do not yet carry a tenant-authenticated state commitment. Streamed reads are authenticated at successful end-of-stream, so callers can observe chunks before the final CID check completes. Live subscription events are outside this query/read response-verification boundary.
