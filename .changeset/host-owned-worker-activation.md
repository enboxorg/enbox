---
"@enbox/browser": patch
---

Leave waiting service-worker activation to the application instead of calling skipWaiting from activatePolyfills. Retain client claiming after activation and DRL fetch interception, so initial preparation still completes while update prompts can wait for application work to finish.
