---
"@enbox/agent": patch
"@enbox/dids": patch
"@enbox/connect": patch
"@enbox/dwn-clients": patch
"@enbox/dwn-sql-store": patch
---

refactor: reduce cognitive complexity across smaller packages (Sonar S3776)

Behavior-preserving extract-method refactoring of 12 functions (CC 16–29) to the ≤15
threshold, across five packages:

- **agent** — DID-resolver-cache `get`, three connect-protocol-preparation functions,
  `AgentDwnApi.sendDwnRpcRequest`, and two `dwn-encryption` reply/decrypter functions.
- **dids** — `did-dht-dns` `fromDnsPacket` / `toDnsPacket`.
- **connect** — relay transport `awaitResponse`.
- **dwn-clients** — `sendDwnRequest` body parsing.
- **dwn-sql-store** — `processFilter` range handling.

Each extraction lifts a contiguous block into a named helper called at the same point.
The boolean transforms (De Morgan negations in `dwn-encryption.maybeDecryptReply`,
guard inversions, and one loop `continue`→`return`) were each verified algebraically
exact, so record decryption fires under identical conditions and every check/error/
order/side-effect is preserved. Notably, `relay-transport.awaitResponse` preserves the
subtle "onClaimed-callback throw is swallowed, leaving `claimedNotified` set" edge case.

The `dwn-api.ts` `constructDwnMessage` monster (CC 97) and the S107 parameter-count
findings are deferred to dedicated follow-ups.

Verified: build + lint clean across all five; connect (82), dids (320), dwn-clients
(206), and agent (1357) test suites pass; dwn-sql-store's DB-backed suite runs in CI.
