---
"@enbox/api": patch
---

feat(api): expose `squash` on typed `records.create`

The typed `create` wrapper now forwards the `squash` directive to the underlying
`records.write`, so `$squash`-enabled protocol paths can be compacted through the
typed surface instead of dropping the flag.
