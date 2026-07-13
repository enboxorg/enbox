---
"@enbox/agent": patch
"@enbox/connect": patch
"@enbox/auth": patch
"@enbox/browser": patch
"@enbox/api": patch
"@enbox/cli": patch
---

Add delegated connect-session status, expiry error helpers, opt-in monitoring, and same-delegate grant refresh across the auth and browser APIs. Refresh requests now carry an explicit wallet UI signal, reuse the existing delegate keys on popup and relay transports, and select fresh active grants over expired or superseded grants. Connect results now fail closed when grants come from the wrong owner, exceed the requested scope, or contain no usable requested grant.
