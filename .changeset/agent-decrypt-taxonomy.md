---
"@enbox/agent": patch
"@enbox/api": patch
---

feat(agent): typed error taxonomy for recipient-side role-audience decrypt failures

Recipient-side decrypt failures now throw `AudienceDecryptError` carrying a machine-readable
`cause` (`'not-wrapped-for-role' | 'delivery-missing' | 'role-not-held' | 'audience-superseded' |
'remote-unverifiable' | 'unknown'`) plus `recordId`, `protocol`, `recipientDid`, and a `detail`
string, instead of one generic prose error with the real cause swallowed by logging. Previously
logger-only observations (rejected role-holder verification, skipped grantKeys, unreachable-remote
lookups) are folded into the error data. `@enbox/api` re-exports the class and cause type so apps
can catch it from record data rejections.
