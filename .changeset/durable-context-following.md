---
"@enbox/api": patch
---

Persist shared-context following choices in private encrypted protocol records and
restore them through the existing context APIs across devices. Propagate explicit
forget and leave decisions without treating temporary owner unavailability as a
forget. Keep membership authority and acceptance fencing local to each device.
Allow saved choices to be forgotten by owner and context ID when access is no
longer available, and preserve newer choices that the current app cannot restore.
Expose saved follows through existing context observations so unavailable shares
can be discovered and forgotten on a fresh device.

Derive context roles from each root's read action rules in declared preference
order. Replace application role groups with exact context paths in following
requests, invitations, and saved choices; expose membership through
`ownedContext.members`. The protocol definition supplies one policy shared by
owners and recipients, without app-level overrides.

Breaking: managed protocol definitions and invitation payloads change. Reusing
an existing owner installation requires explicit `configure()`; automatic
readiness only warns about a differing definition. Delegates reject a mismatched
wallet definition with `WalletReapprovalRequiredError`; reconnect for updated
approval. Existing local acceptances are not backfilled into the journal; follow
again to save a cross-device choice.
