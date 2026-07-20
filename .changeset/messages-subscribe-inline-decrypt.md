---
"@enbox/agent": patch
"@enbox/api": patch
---

feat: hydrated records + opt-in inline decryption for `messages.subscribe()`

`messages.subscribe()` now hydrates every `RecordsWrite` event into a full
`Record` on `MessageChange.record` — the multi-interface analogue of what
`records.subscribe()` yields for a single filter; non-`RecordsWrite` events
(deletes, protocol configures) carry no record. The new `encryption: true`
option decrypts each event's small inline payload the way
`records.subscribe({ encryption: true })` already does (#1354), so a
cross-protocol change feed reads plaintext from `record.data` without a re-read
round-trip. `encryption` governs only decryption, not hydration — hydration is
unconditional. A record that cannot be decrypted never kills the feed: its
inline ciphertext is withheld and the record's lazy read surfaces the error on
access (or resolves once a key arrives).

Under the hood the agent's subscription decrypt-wrapper
(`maybeWrapSubscriptionHandlerForDecryption`) now covers both `RecordsSubscribe`
and `MessagesSubscribe`; the per-event decrypt stays message-content driven, so
only a `RecordsWrite` carrying an encryption envelope is touched and every other
message type on the heterogeneous feed passes through untouched.
