---
"@enbox/dwn-sdk-js": patch
"@enbox/agent": patch
"@enbox/api": patch
---

fix: publish new versions to fix MessagesSync export chain

@enbox/agent@0.1.1 imports MessagesSync from @enbox/dwn-sdk-js, but
@enbox/dwn-sdk-js@0.0.2 was published before that export was added.
This bumps all three packages so downstream consumers (demo apps) can
resolve the full dependency chain.
