---
"@enbox/browser": patch
---

Resolve application icon URLs against the page origin, or document URL for opaque origins, when BrowserConnectHandler requests access, keeping handler creation inert.
