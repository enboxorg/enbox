---
"@enbox/agent": patch
---

Reject raw RecordsWrite payloads whose CID or size does not match the signed message before local processing or remote transmission. One-shot streams are currently validated over the whole payload before dispatch so plaintext can never leave under a ciphertext-committing message; a later stored-byte streaming pass can make this incremental without exposing plaintext.
