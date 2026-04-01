---
"@enbox/agent": minor
---

feat: dead letter tracking and sync health API

Adds durable tracking of permanently failed sync messages in a LevelDB
sublevel. Failed messages are no longer logged and forgotten — they persist
until explicitly cleared by the application.

New public API on SyncEngine:
- `getFailedMessages(tenantDid?)` — list all dead letter entries
- `clearFailedMessage(messageCid)` — remove a single entry
- `clearAllFailedMessages(tenantDid?)` — clear all or scoped to a tenant
- `getSyncHealth()` — summary with connectivity, failed count, degraded links

Push permanent failures (400/401/403) now carry structured diagnostic info
(`PermanentPushFailure` type with `statusCode` and `detail`) and are
automatically recorded in the dead letter store.
