---
"@enbox/agent": patch
"@enbox/api": patch
---

feat: opt-in inline decryption for `messages.subscribe()`

`messages.subscribe({ encryption: true })` now delivers `RecordsWrite` events as
hydrated `Record` objects on `MessageChange.record`, auto-decrypting the small
inline payload the same way `records.subscribe({ encryption: true })` already
does — the multi-interface analogue, so a cross-protocol change feed reads
plaintext from `record.data` without a re-read round-trip. Non-`RecordsWrite`
events are unaffected, and a record that cannot be decrypted never kills the
feed: its inline ciphertext is withheld and the record's lazy read surfaces the
decryption error on access (or resolves once a key arrives).

Under the hood the agent's subscription decrypt-wrapper
(`maybeWrapSubscriptionHandlerForDecryption`) now covers both `RecordsSubscribe`
and `MessagesSubscribe`; the per-event decrypt stays message-content driven, so
only a `RecordsWrite` carrying an encryption envelope is touched and every other
message type on the heterogeneous feed passes through untouched.
