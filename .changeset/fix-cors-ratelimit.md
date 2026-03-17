---
"@enbox/dwn-server": patch
"@enbox/agent": patch
---

fix(dwn-server): include CORS headers on per-IP rate-limit 429 responses so browsers can read the error instead of treating it as a CORS failure

fix(agent): throttle sync engine remote requests to prevent rate-limit bursts — tree walk is now gated by a semaphore (max 4 concurrent remote requests) and pull concurrency reduced from 10 to 4
