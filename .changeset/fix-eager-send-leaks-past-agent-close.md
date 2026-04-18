---
"@enbox/agent": patch
---

fix(agent): drain in-flight eager contextKey sends before agent teardown so tests don't surface LEVEL_DATABASE_NOT_OPEN or 'Agent DID is not set' as unhandled errors between tests
