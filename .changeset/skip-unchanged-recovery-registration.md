---
"@enbox/auth": patch
---

Preserve existing tenant registration when explicit phrase-recovery endpoints already match the DID route, and avoid redundant endpoint resolution after a successful recovery update.

Require the owning manager's lifecycle guards for internal registration and recovery operations instead of permitting unguarded fallbacks.

Use the flow operation signal directly for tenant registration so vault and recovery flows share their lifecycle context without adapter objects.

Prepare recovered delegates with their own signing DID and active local grant scope before pulling protocol data. Prefer recovered local owners and keep the first usable delegate registration for each external owner. Skip delegated data recovery when local grants are unavailable, and keep recovery without an explicit identity scope limited to metadata.
